// Exercise the actual mobile bundle with synthetic sessions and no terminal
// input. Android WebView can become visible without delivering visibilitychange.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const contentResponse = require('../server/services/content-response');

const createdAt = '2026-10-20T00:00:00Z';
const initialAnswer = '合成最终回答：打开应用后无需发送消息。';

async function fixture(browser, hidden, { heldInitialList = false } = {}) {
  const session = {
    name: 'lifecycle-reader', displayName: '前台恢复合成会话', createdAt,
    shell: 'codex', status: 'running',
    activity: { available: true, detected: true, phase: 'completed', busy: false, completed: 'fixed-completion' },
  };
  // Deliberately keep phase/busy/completed identical across every list and WS
  // snapshot. A state-change notification must not accidentally rescue reading.
  const sessions = heldInitialList ? [session,
    { ...session, name: 'other-done', displayName: '另一条已完成合成会话' },
    { ...session, name: 'other-worker', displayName: '另一条工作合成会话',
      activity: { available: true, detected: true, phase: 'working', busy: true, completed: null } },
  ] : [session];
  const manager = new EventEmitter(); manager.list = () => sessions;
  let answer = initialAnswer, inputs = 0, mobileRequests = 0, listRequests = 0;
  const app = express(); app.use(express.json());
  app.get('/api/sessions', (_req, res) => {
    listRequests++;
    if (heldInitialList && listRequests === 1) return; // Simulate an old suspended request with no headers.
    res.json({ sessions: manager.list() });
  });
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.get('/api/sessions/:name/mobile', (req, res) => {
    mobileRequests++;
    contentResponse(req, res, req.query.view === 'full'
      ? { text: 'SYNTHETIC_FULL_DETAIL\n' + answer, completed: session.activity.completed }
      : { messages: [{ id: 'fixed-answer', role: 'assistant', phase: 'final_answer', text: answer }], completed: session.activity.completed });
  });
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.status(409).json({ error: 'This fixture never accepts input' }); });
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager);
  await once(server, 'listening');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ createdAt, hidden, heldInitialList, sessions }) => {
    localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'lifecycle-reader', createdAt }));
    if (heldInitialList) {
      localStorage.setItem('web-ttyd-hub.session-metadata.v1', JSON.stringify({ version: 1, savedAt: Date.now(), sessions,
        selection: { name: 'lifecycle-reader', createdAt }, read: {}, layout: { order: [], pinned: [] },
        shells: [{ id: 'codex', name: 'Codex' }], platform: 'linux' }));
      window.WebSocket = class { constructor() { throw Error('Synthetic blocked notification connection'); } };
    }
    window.__lifecycleHidden = hidden;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__lifecycleHidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__lifecycleHidden ? 'hidden' : 'visible' });
    // These are reading-only scenarios. Avoid marking even synthetic replies read.
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
  }, { createdAt, hidden, heldInitialList, sessions });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.mobile-session-title').filter({ hasText: session.displayName }).waitFor();
  return {
    page, errors,
    get inputs() { return inputs; },
    get mobileRequests() { return mobileRequests; },
    get listRequests() { return listRequests; },
    changeAnswer(value) { answer = value; },
    async close() {
      await context.close(); wss.clients.forEach(client => client.terminate()); wss.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    },
  };
}

async function hiddenStartup(browser) {
  const f = await fixture(browser, true);
  try {
    await f.page.waitForTimeout(1000);
    assert(f.listRequests > 0, 'The initial list succeeds while the WebView is hidden');
    assert.equal(f.mobileRequests, 0, 'A background WebView does not download a terminal before becoming visible');
    // Change only the browser getter. No visibility/focus/pageshow/online event,
    // status change, click or key can serve as an accidental recovery trigger.
    await f.page.evaluate(() => { window.__lifecycleHidden = false; });
    try {
      await f.page.locator('.message.assistant').filter({ hasText: initialAnswer }).waitFor({ timeout: 6500 });
    } catch (error) {
      error.message += ` (list requests: ${f.listRequests}, mobile requests: ${f.mobileRequests}, inputs: ${f.inputs})`;
      throw error;
    }
    assert(f.mobileRequests > 0, 'Reading resumes when visible even if the platform drops its lifecycle event');
    assert.equal(f.inputs, 0, 'Opening the app never requires a terminal submission');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}

async function explicitResume(browser, event) {
  const f = await fixture(browser, false);
  try {
    await f.page.locator('.message.assistant').filter({ hasText: initialAnswer }).waitFor({ timeout: 3000 });
    // A completed task normally uses a long refresh interval. Resuming must
    // bypass it even when the completion identity itself did not change.
    const before = f.mobileRequests, nextAnswer = `${event} 恢复后的合成最终回答`;
    f.changeAnswer(nextAnswer);
    await f.page.evaluate(event => window.dispatchEvent(event === 'pageshow'
      ? new PageTransitionEvent('pageshow', { persisted: true }) : new Event('focus')), event);
    await f.page.locator('.message.assistant').filter({ hasText: nextAnswer }).waitFor({ timeout: 1800 });
    assert(f.mobileRequests > before, `${event} immediately revalidates an unchanged completion`);
    assert.equal(f.inputs, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}

async function cachedHeldList(browser) {
  const f = await fixture(browser, true, { heldInitialList: true });
  try {
    await f.page.waitForTimeout(1000);
    assert.equal(f.listRequests, 1, 'Only the initial held request exists while the cached WebView is hidden');
    assert.equal(f.mobileRequests, 0, 'Cached identity remains unverified until a fresh list arrives');
    assert.equal(await f.page.locator('.unread-badge, .working-badge').count(), 0, 'Cached task states are not advertised as live');
    await f.page.evaluate(() => { window.__lifecycleHidden = false; });
    try {
      await f.page.locator('.message.assistant').filter({ hasText: initialAnswer }).waitFor({ timeout: 2500 });
    } catch (error) {
      error.message += ` (list requests: ${f.listRequests}, mobile requests: ${f.mobileRequests}, inputs: ${f.inputs})`;
      throw error;
    }
    assert(f.listRequests >= 2, 'Silent foreground recovery replaces the suspended initial list request');
    assert.equal(await f.page.locator('.unread-badge').textContent(), '1');
    assert.equal(await f.page.locator('.working-badge').textContent(), '1');
    assert.equal(f.inputs, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const failures = [];
  const cases = [
    ['hidden-without-event', () => hiddenStartup(browser)],
    ['focus', () => explicitResume(browser, 'focus')],
    ['pageshow', () => explicitResume(browser, 'pageshow')],
    ['cached-held-list', () => cachedHeldList(browser)],
  ];
  try {
    for (const [name, run] of cases) {
      if (process.env.HUB_LIFECYCLE_CASE && process.env.HUB_LIFECYCLE_CASE !== name) continue;
      try { await run(); console.log(`PASS mobile lifecycle ${name}: fresh content without terminal input`); }
      catch (error) { failures.push(name); console.error(`FAIL mobile lifecycle ${name}: ${error.message}`); }
    }
    assert.deepEqual(failures, [], 'Mobile reading must recover from every foreground path without user input');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
