// Cold WebView lifecycle, real rollout parser/mobile route, synthetic data only.
// No live terminal/model/shared read write. Cold-start scenarios submit no input;
// replacement scenarios use only the isolated fixture's fake input endpoint.
const assert = require('node:assert/strict');
const express = require('express');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const routes = require('../server/routes/sessions');
const SessionManager = require('../server/services/session-manager');
const { CodexActivity } = require('../server/services/codex-activity');

const createdAt = '2026-10-20T00:00:00Z';
const answer = '合成历史最终回答：冷启动无需发送消息即可阅读。';
const dialoguePending = '对话记录尚未就绪，可先查看全文。';
const terminal = '完整终端合成记录\n• Ran synthetic-build\n  └ TOOL_DETAIL_ONLY_IN_FULL\n' + answer;
const screenshots = path.join(__dirname, '../output/playwright/ux-audit');

async function fixture(browser, { hidden = false, cachedFallback = false, withOther = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-cold-reader-'));
  const filename = path.join(directory, 'rollout-cold.jsonl');
  const row = (type, payload) => JSON.stringify({ type, timestamp: createdAt, payload }) + '\n';
  await fs.writeFile(filename, row('event_msg', { type: 'task_started', turn_id: 'historical' }) +
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '合成历史问题' }] }) +
    row('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }) +
    row('event_msg', { type: 'task_complete', turn_id: 'historical' }));
  let bound = false, inputCalls = 0, discoveryReads = 0, acceptInputs = false, generation = 0;
  const session = { name: 'cold-reader', displayName: '冷启动合成检查', createdAt, shell: 'codex', status: 'running',
    activity: { available: false, detected: true, phase: 'unknown', busy: false, completed: null } };
  const manager = new EventEmitter();
  manager.sessions = new Map([[session.name, session]]);
  if (withOther) manager.sessions.set('other-cold', { ...session, name: 'other-cold', displayName: '另一个合成会话' });
  manager.list = () => [...manager.sessions.values()];
  manager.serialize = value => value;
  manager.getSession = name => manager.sessions.get(name);
  manager.ensurePane = async () => {};
  manager.history = async () => ({ text: terminal });
  manager.activity = new CodexActivity(manager, { observer: { observe: async () => ({ detected: true, path: bound ? filename : null }) } });
  clearInterval(manager.activity.timer);
  // Inject only OS/process discovery. Parsing, publication and HTTP view choice
  // are production code. The first read has no binding and cannot use input.
  manager.activity.poll = async () => {
    discoveryReads++;
    await manager.activity.update(session, { pid: 'synthetic', id: '=__hub_cold_no_pane__' });
  };
  manager.mobile = SessionManager.prototype.mobile;
  const app = express(); app.use(express.json());
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.post('/api/sessions/:name/input', (_req, res) => {
    inputCalls++;
    if (acceptInputs) res.json({ ok: true });
    else res.status(500).json({ error: 'Synthetic unconfirmed input' });
  });
  app.use('/api/sessions', routes(manager));
  app.get('/cache-seed', (_req, res) => res.send('<!doctype html><title>Cache seed</title>'));
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager);
  await once(server, 'listening');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ createdAt, hidden }) => {
    localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'cold-reader', createdAt }));
    if (hidden) Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  }, { createdAt, hidden });
  const page = await context.newPage(), url = `http://127.0.0.1:${server.address().port}`;
  if (cachedFallback) {
    await page.goto(url + '/cache-seed');
    await page.evaluate(async ({ createdAt }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ttyd-hub-content-v1', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('content', { keyPath: 'key' });
          request.result.createObjectStore('metadata', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const entry = { key: JSON.stringify(['cold-reader', createdAt, 'answer']), sessionId: 'cold-reader', generation: createdAt,
        data: { text: '旧版缓存的终端全文：STALE_FULL_FALLBACK' }, used: Date.now(), bytes: 100 };
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['content', 'metadata'], 'readwrite');
        tx.objectStore('content').put(entry); tx.objectStore('metadata').put({ ...entry, data: undefined });
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, { createdAt });
  }
  await page.goto(url);
  await page.locator('.mobile-session-title').waitFor();
  return { page, manager, session,
    get inputs() { return inputCalls; }, get discoveryReads() { return discoveryReads; },
    async discover() { bound = true; await manager.activity.poll(); },
    acceptInputs() { acceptInputs = true; },
    async replace() {
      await fs.writeFile(filename, '');
      session.createdAt = `${createdAt}:replacement-${++generation}`;
      manager.activity.states.delete(session.name);
      await manager.activity.poll();
      manager.emit('session:renamed', session);
    },
    async close() {
      await context.close(); manager.activity.close();
      wss.clients.forEach(ws => ws.terminate()); wss.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

(async () => {
  await fs.mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const cachedFallback of [false, true]) {
      const f = await fixture(browser, { cachedFallback });
      try {
        await f.page.waitForTimeout(250);
        assert.doesNotMatch(await f.page.locator('.mobile-reading').innerText(), /TOOL_DETAIL_ONLY_IN_FULL|STALE_FULL_FALLBACK/,
          'Answer mode must never present raw execution logs as an answer, including the first read');
        await f.page.getByText(cachedFallback ? dialoguePending : '正在读取回答…', { exact: true }).waitFor({ timeout: 1000 });
        assert.equal(await f.page.getByText('暂时无法读取回答，正在自动重试。', { exact: true }).count(), 0,
          'An optional cached terminal snapshot is not a failed answer request');
        if (cachedFallback) await f.page.screenshot({ path: path.join(screenshots, '01-cold-start-fallback.png') });
        await f.page.locator('.answer-placeholder').getByRole('button', { name: '查看全文', exact: true }).tap();
        await f.page.getByText(/TOOL_DETAIL_ONLY_IN_FULL/).waitFor({ timeout: 1000 });
        await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
        await f.page.getByText(cachedFallback ? dialoguePending : '正在读取回答…', { exact: true }).waitFor({ timeout: 1000 });
        assert.equal(f.inputs, 0);
        await f.discover();
        await f.page.locator('.message.assistant').filter({ hasText: answer }).waitFor({ timeout: 2500 });
        assert(!/TOOL_DETAIL_ONLY_IN_FULL|STALE_FULL_FALLBACK/.test(await f.page.locator('.mobile-reading').innerText()));
        await f.page.locator('.mobile-session-header').getByText('已完成 · 已读', { exact: true }).waitFor({ timeout: 1000 });
        assert(f.discoveryReads >= 2, 'Discovery retries while idle; a message cannot be its trigger');
        if (cachedFallback) await f.page.screenshot({ path: path.join(screenshots, '02-cold-start-idle-answer.png') });
        await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
        await f.page.getByText(/TOOL_DETAIL_ONLY_IN_FULL/).waitFor({ timeout: 1000 });
        if (cachedFallback) await f.page.screenshot({ path: path.join(screenshots, '03-cold-start-full.png') });
        await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
        await f.page.locator('.message.assistant').filter({ hasText: answer }).waitFor({ timeout: 1000 });
        assert.equal(f.inputs, 0);
        console.log(`PASS cold startup ${cachedFallback ? 'with cached terminal fallback' : 'with empty cache'} discovers historical final answer, status and both views without input`);
      } finally { await f.close(); }
    }
    const f = await fixture(browser, { hidden: true, cachedFallback: true });
    try {
      await f.discover();
      await f.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await f.page.locator('.message.assistant').filter({ hasText: answer }).waitFor({ timeout: 2500 });
      await f.page.locator('.mobile-session-header').getByText('已完成 · 已读', { exact: true }).waitFor({ timeout: 1000 });
      await f.page.screenshot({ path: path.join(screenshots, '04-hidden-resumed-answer.png') });
      assert.equal(f.inputs, 0);
      console.log('PASS initially hidden WebView resumes discovery and reading without input');
    } finally { await f.close(); }
    const unavailable = await fixture(browser);
    try {
      await unavailable.page.getByText(dialoguePending, { exact: true }).waitFor({ timeout: 6500 });
      // Passing ten seconds cannot turn a successful HTTP fallback into a
      // transport error. Advance the displayed clock without delaying the suite.
      await unavailable.page.evaluate(() => {
        const realNow = Date.now;
        Date.now = () => realNow() + 11000;
      });
      await unavailable.page.waitForTimeout(1100);
      assert.equal(await unavailable.page.getByText(dialoguePending, { exact: true }).count(), 1);
      assert.equal(await unavailable.page.getByText('暂时无法读取回答，正在自动重试。', { exact: true }).count(), 0,
        'A successful text-only response stays a neutral source wait regardless of elapsed time');
      assert.equal(await unavailable.page.locator('.mobile-output').count(), 0);
      assert.equal(await unavailable.page.locator('.status-guidance').count(), 0, 'An unavailable answer needs no additional header banner');
      await unavailable.page.screenshot({ path: path.join(screenshots, '05-answer-source-unavailable.png') });
      await unavailable.page.locator('.answer-placeholder').getByRole('button', { name: '查看全文', exact: true }).tap();
      await unavailable.page.getByText(/TOOL_DETAIL_ONLY_IN_FULL/).waitFor({ timeout: 1000 });
      assert.equal(unavailable.inputs, 0);
      await unavailable.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await unavailable.discover();
      await unavailable.page.locator('.message.assistant').filter({ hasText: answer }).waitFor({ timeout: 2500 });
      assert.equal(await unavailable.page.locator('.answer-placeholder').count(), 0,
        'Natural source recovery clears the waiting state without input');
      assert.equal(unavailable.inputs, 0);
      console.log('PASS successful terminal fallback stays neutral past ten seconds, keeps Full accessible and naturally restores the answer without input');
    } finally { await unavailable.close(); }
    const replacement = await fixture(browser, { withOther: true });
    try {
      const page = replacement.page, input = page.getByLabel('消息输入');
      async function select(name) {
        const menu = page.getByRole('button', { name: '会话列表', exact: true });
        if (await menu.getAttribute('aria-expanded') === 'false') await menu.tap();
        await page.locator(`[data-session-id="${name}"]`).click();
        await input.waitFor();
        await page.locator('.sidebar').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
      }
      async function replaceAndSelect() {
        await replacement.replace();
        await page.locator('.mobile-empty').waitFor({ timeout: 2000 });
        await select('cold-reader');
        assert.equal(await input.inputValue(), '', 'A replacement terminal cannot inherit the old draft');
        assert.equal(await page.locator('.pending-message').count(), 0);
        assert.equal(await page.getByRole('alert').count(), 0);
        assert.equal(await page.locator('.input-notice').count(), 0);
      }
      await replacement.discover();
      await page.locator('.message.assistant').filter({ hasText: answer }).waitFor({ timeout: 2000 });
      await input.fill('切换到其他会话时应保留的草稿');
      await select('other-cold'); await select('cold-reader');
      assert.equal(await input.inputValue(), '切换到其他会话时应保留的草稿', 'Ordinary session switching still preserves drafts');
      await input.fill('旧会话未确认的合成消息'); await page.locator('.send').tap();
      await page.locator('.pending-message.uncertain').waitFor();
      assert.equal(await page.getByRole('alert').count(), 1, 'An uncertain prompt has one alert inside its pending card');
      await input.fill('OLD_PRIVATE_DRAFT');
      await replaceAndSelect();
      await input.fill('/status'); await page.locator('.send').tap();
      await page.getByRole('alert').filter({ hasText: '未确认发送成功' }).waitFor();
      await replaceAndSelect();
      replacement.acceptInputs();
      await input.fill('/status'); await page.locator('.send').tap();
      await page.getByText('已发送到终端', { exact: true }).waitFor();
      await input.fill('旧会话通知旁的草稿');
      await replaceAndSelect();
      await page.screenshot({ path: path.join(screenshots, '07-replacement-session-clean.png') });
      assert.equal(replacement.inputs, 3, 'Only explicit synthetic submissions occur; replacement never resends input');
      console.log('PASS replacement generations clear old drafts, pending prompts, errors and notices while ordinary switching preserves drafts');
    } finally { await replacement.close(); }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
