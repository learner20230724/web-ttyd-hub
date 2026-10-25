// The full terminal already contains the final reply. Opening the answer view
// must converge from an old/retained reply without typing, clicking or focus.
// Separate viewport cases also exercise resize/foreground events after final.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const contentResponse = require('../server/services/content-response');
const SessionSync = require('../server/services/session-sync');

const createdAt = '2026-10-25T00:00:00Z';
const partial = '合成旧进展：工作还没有结束。';
const final = '合成最终回答：全文与回答必须自动收敛到这条已完成回复。';
const message = (text, phase) => ({ id: phase === 'commentary' ? 'old-progress' : 'final-reply', role: 'assistant', text, phase });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(browser, scenario) {
  const lateRevision = scenario.startsWith('late-revision');
  const hang = scenario.startsWith('hung-');
  const retained = scenario === 'retained-completion';
  const readGuard = scenario === 'same-completion-read-guard';
  const longHistory = ['stale-revision', 'viewport-follow', 'viewport-history'].includes(scenario);
  const versioned = lateRevision || scenario === 'stale-revision' || readGuard || longHistory;
  const history = longHistory ? Array.from({ length: 80 }, (_, index) => ({ id: `history-${index}`, role: index % 2 ? 'assistant' : 'user',
    phase: 'final_answer', text: `合成历史第 ${index + 1} 条，用于验证一百条左右对话时最终回复确实出现在阅读视口中。` })) : [];
  const session = { name: 'answer-convergence', displayName: '最终回复收敛合成会话', createdAt, shell: 'codex', status: 'running',
    activity: { available: true, detected: true, busy: false, phase: 'completed', completed: 't2',
      ...(versioned ? { contentRevision: lateRevision ? 'r1' : 'r2' } : {}) } };
  const stale = { messages: [...history, message(partial, 'commentary')], completed: versioned ? 't2' : 't1',
    ...(versioned ? { contentRevision: 'r1' } : {}) };
  const ready = { messages: [...history, message(final, 'final_answer')], completed: 't2',
    ...(versioned ? { contentRevision: 'r2' } : {}) };
  const manager = new EventEmitter(); manager.sessions = new Map([[session.name, session]]); manager.list = () => [session];
  manager.sync = new SessionSync(manager);
  manager.sync.restore({ revision: 1, read: { [session.name]: { createdAt, completed: 't1' } }, layout: { order: [session.name], pinned: [] } });
  let answers = 0, inputs = 0, listReads = 0;
  const reads = [];
  const app = express();
  app.use(express.json());
  app.get('/api/sessions', (_req, res) => { listReads++; res.json({ sessions: [session], shared: manager.sync.snapshot() }); });
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.get('/api/sessions/:name/mobile', (req, res) => {
    if (req.query.view === 'full') return contentResponse(req, res, { text: 'SYNTHETIC_TOOL_LOG\n' + final, completed: 't2' });
    const first = ++answers === 1;
    contentResponse(req, res, first && !hang
      ? retained ? { text: 'SYNTHETIC_TOOL_LOG\n' + final, completed: 't2' } : stale
      : ready);
  });
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.sendStatus(405); });
  app.post('/api/sessions/sync', (req, res) => {
    assert.equal(req.body.type, 'read'); reads.push(req.body); res.json(manager.sync.apply(req.body));
  });
  app.get('/cache-seed', (_req, res) => res.send('<!doctype html><title>Synthetic cached answer</title>'));
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager); await once(server, 'listening');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ createdAt, scenario }) => {
    localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'answer-convergence', createdAt }));
    localStorage.setItem('web-ttyd-hub.shared-migrated.v1', '1');
    document.hasFocus = () => scenario === 'same-completion-read-guard';
    if (scenario.startsWith('hung-')) {
      // No lifecycle notification can accidentally replace the suspended read.
      window.WebSocket = class { constructor() { throw Error('Synthetic unavailable notification channel'); } };
      const originalTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, ms, ...args) => originalTimeout(callback, ms === 15000 ? 300 : ms, ...args);
      const originalFetch = window.fetch.bind(window);
      window.__hijackedAnswer = 0;
      window.fetch = (input, options) => {
        const url = typeof input === 'string' ? input : input.url;
        if (/\/api\/sessions\/answer-convergence\/mobile$/.test(url) && window.__hijackedAnswer++ === 0) {
          if (scenario === 'hung-fetch') return new Promise(() => {});
          return Promise.resolve({ status: 200, ok: true, headers: new Headers(), json: () => new Promise(() => {}) });
        }
        return originalFetch(input, options);
      };
    }
  }, { createdAt, scenario });
  const url = `http://127.0.0.1:${server.address().port}`;
  if (retained || hang) {
    const seed = await context.newPage(); await seed.goto(url + '/cache-seed');
    await seed.evaluate(async ({ createdAt, stale }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ttyd-hub-content-v1', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('content', { keyPath: 'key' });
          request.result.createObjectStore('metadata', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const entry = { key: JSON.stringify(['answer-convergence', createdAt, 'answer']), sessionId: 'answer-convergence',
        generation: createdAt, data: stale, used: Date.now(), bytes: JSON.stringify(stale).length * 2 };
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['content', 'metadata'], 'readwrite');
        tx.objectStore('content').put(entry); tx.objectStore('metadata').put({ ...entry, data: undefined });
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, { createdAt, stale });
    await seed.close();
  }
  // Establish that the terminal is complete before opening the app; this GET
  // comes from the test process and cannot trigger any browser refresh handler.
  const full = await (await fetch(url + '/api/sessions/answer-convergence/mobile?view=full')).json();
  assert(full.text.includes(final));
  const page = await context.newPage(), errors = [], browserInputs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.method() !== 'GET') browserInputs.push(req.url()); });
  await page.goto(url);
  await page.getByText(partial, { exact: true }).waitFor({ timeout: 2500 });
  if (lateRevision) {
    session.activity = { ...session.activity, contentRevision: 'r2' };
    if (scenario === 'late-revision-ws') manager.emit('session:activity', session);
  }
  return { page, errors, browserInputs, reads, get answers() { return answers; }, get lists() { return listReads; }, get inputs() { return inputs; },
    async close() {
      await context.close(); wss.clients.forEach(client => client.terminate()); wss.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    } };
}

async function finalWithinReadingViewport(page) {
  const geometry = await page.locator('.message.assistant[data-message-id="final-reply"]').evaluate(element => {
    const pane = element.closest('.mobile-reading'), message = element.getBoundingClientRect(), reading = pane.getBoundingClientRect();
    return { top: message.top, bottom: message.bottom, viewportTop: reading.top, viewportBottom: reading.bottom,
      scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight };
  });
  assert(geometry.top >= geometry.viewportTop - 1 && geometry.bottom <= geometry.viewportBottom + 1,
    'The final reply must actually be inside the reading viewport: ' + JSON.stringify(geometry));
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const failures = [];
  const cases = ['stale-completion', 'retained-completion', 'stale-revision', 'late-revision-ws', 'late-revision-http', 'hung-fetch', 'hung-json', 'same-completion-read-guard', 'viewport-follow', 'viewport-history'];
  try {
    for (const scenario of cases) {
      if (process.env.HUB_CONVERGENCE_CASE && process.env.HUB_CONVERGENCE_CASE !== scenario) continue;
      let f;
      try {
        f = await fixture(browser, scenario);
        const screenshotDir = scenario === 'stale-revision' && process.env.HUB_CONVERGENCE_SCREENSHOTS;
        if (screenshotDir) {
          await fs.mkdir(path.resolve(screenshotDir), { recursive: true });
          await f.page.screenshot({ path: path.resolve(screenshotDir, '01-partial.png') });
        }
        if (scenario === 'same-completion-read-guard') {
          await delay(250);
          assert.equal(await f.page.locator('.mobile-reading').getAttribute('data-content-revision'), 'r1', 'The DOM still represents partial r1, not the current metadata revision');
          assert.equal(f.reads.length, 0, 'Partial r1 cannot acknowledge completed t2 when the current answer revision is r2');
        }
        const start = Date.now();
        await f.page.getByText(final, { exact: true }).waitFor({ timeout: scenario === 'late-revision-http' ? 6500 : 3500 });
        const finalVisibleMs = Date.now() - start;
        assert.equal(await f.page.getByText(partial, { exact: true }).count(), 0, 'The stale partial must actually be replaced');
        assert.equal(await f.page.locator('.message[data-message-id="final-reply"] .speaker').getByText('Codex · 回复', { exact: true }).count(), 1);
        assert.equal(await f.page.locator('.mobile-reading').getAttribute('data-content-completed'), 't2');
        if (['stale-revision', 'late-revision-ws', 'late-revision-http', 'same-completion-read-guard', 'viewport-follow', 'viewport-history'].includes(scenario)) {
          assert.equal(await f.page.locator('.mobile-reading').getAttribute('data-content-revision'), 'r2', 'The rendered answer itself must reach r2');
        }
        assert.equal(await f.page.locator('.message.assistant[data-message-id="final-reply"]').count(), 1);
        await finalWithinReadingViewport(f.page);
        if (scenario === 'stale-revision') assert.equal(await f.page.locator('.message').count(), 81, 'The actual cold-open fixture includes 80 earlier messages');
        if (scenario.startsWith('viewport-')) {
          if (scenario === 'viewport-history') {
            await f.page.locator('.mobile-reading').evaluate(pane => { pane.scrollTop = 0; pane.dispatchEvent(new Event('scroll')); });
            await f.page.getByRole('button', { name: '↓ 回到最新', exact: true }).waitFor();
          }
          // Window-height changes stand in for keyboard/inset changes. No
          // composer focus, typing, terminal input or reading-mode toggle.
          await f.page.setViewportSize({ width: 412, height: 440 });
          await f.page.waitForTimeout(250);
          await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await f.page.waitForTimeout(250);
          assert.equal(await f.page.locator('.mobile-reading').getAttribute('data-content-revision'), 'r2');
          if (scenario === 'viewport-follow') await finalWithinReadingViewport(f.page);
          else assert(await f.page.locator('.mobile-reading').evaluate(pane => pane.scrollTop < 2), 'Deliberately reading old history must not jump to the final answer');
          await f.page.setViewportSize({ width: 412, height: 915 });
          await f.page.waitForTimeout(200);
          if (scenario === 'viewport-follow') await finalWithinReadingViewport(f.page);
          else assert(await f.page.locator('.mobile-reading').evaluate(pane => pane.scrollTop < 2));
        }
        if (screenshotDir) await f.page.screenshot({ path: path.resolve(screenshotDir, '02-final-without-input.png') });
        if (scenario === 'same-completion-read-guard') {
          for (let i = 0; i < 40 && !f.reads.length; i++) await delay(25);
          assert.equal(f.reads.length, 1, 'Only the fully rendered current revision acknowledges this completion');
          assert.equal(f.reads[0].completed, 't2');
          assert.equal(f.reads[0].contentRevision, 'r2');
          assert(f.browserInputs.every(url => url.endsWith('/api/sessions/sync')));
        } else assert.deepEqual(f.browserInputs, [], 'No user input or API writes may rescue convergence');
        assert.equal(f.inputs, 0); assert.deepEqual(f.errors, []);
        assert(f.answers >= (scenario.startsWith('hung-') ? 1 : 2), 'The answer must be independently revalidated');
        if (scenario === 'stale-revision') {
          const settled = f.answers;
          await delay(1500);
          assert.equal(f.answers, settled, 'A verified matching final revision returns to quiet polling');
        }
        console.log(`PASS answer convergence ${scenario}: final visible in ${finalVisibleMs} ms; answers=${f.answers}; lists=${f.lists}; inputs=0`);
      } catch (error) {
        failures.push(scenario); console.error(`FAIL answer convergence ${scenario}: ${error.message}${f ? ` (answers=${f.answers}, lists=${f.lists}, inputs=${f.inputs})` : ''}`);
      } finally { await f?.close(); }
    }
    assert.deepEqual(failures, [], 'A readable partial reply is not proof that the current final answer has been displayed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
