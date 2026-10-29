// Two independent causes, exercised against the built client without cached
// content, clicks, focus, terminal input, or lifecycle recovery events.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const SessionSync = require('../server/services/session-sync');

const createdAt = '2026-10-30T00:00:00Z';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const task = (name, phase) => ({ name, displayName: name, createdAt, shell: 'codex', status: 'running',
  activity: { available: true, detected: true, phase, busy: phase !== 'completed',
    completed: phase === 'completed' ? `${name}:done` : null, contentRevision: `${name}:r1` } });

async function fixture(browser, slow = false) {
  const sessions = [task('reader', slow ? 'working' : 'completed'), task('unread', 'completed'), task('worker', 'working')];
  for (const [index, name] of ['当前会话', '未读回复', '工作任务'].entries()) sessions[index].displayName = name;
  const manager = new EventEmitter();
  manager.sessions = new Map(sessions.map(s => [s.name, s]));
  manager.list = () => sessions;
  manager.serialize = s => s;
  manager.sync = new SessionSync(manager);
  manager.sync.restore({ revision: 1, read: {}, layout: { order: sessions.map(s => s.name), pinned: [] } });
  let failLists = false, failedLists = 0, answers = 0, writes = 0;
  const app = express();
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) { writes++; return res.sendStatus(405); }
    next();
  });
  app.get('/api/sessions', (_req, res) => {
    if (failLists) { failedLists++; return res.status(503).json({ error: 'Synthetic HTTP list outage' }); }
    res.json({ sessions, shared: manager.sync.snapshot() });
  });
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.get('/api/sessions/:name/mobile', (_req, res) => {
    answers++;
    const activity = { ...sessions[0].activity };
    const data = { messages: [{ id: activity.completed ? 'final' : 'progress', role: 'assistant',
      phase: activity.completed ? 'final_answer' : 'commentary',
      text: activity.completed ? '最终回复：打开后即可读取，完成与已读由服务端同步。' : '工作进展：慢速读取期间，任务仍在执行。' }],
    completed: activity.completed, contentRevision: activity.contentRevision };
    const send = () => { if (!res.destroyed) res.json(data); };
    if (slow && !activity.completed) setTimeout(send, 1800); else send();
  });
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager);
  await once(server, 'listening');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ createdAt }) => {
    document.hasFocus = () => false;
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    localStorage.setItem('web-ttyd-hub.shared-migrated.v1', '1');
    localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt }));
  }, { createdAt });
  const page = await context.newPage(), errors = [];
  let socketMessages = 0, answerRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.url().endsWith('/reader/mobile')) answerRequests++; });
  page.on('websocket', socket => socket.on('framereceived', () => socketMessages++));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.working-badge').waitFor({ timeout: 2500 });
  return { page, errors, sessions, manager,
    get answers() { return answers; }, get answerRequests() { return answerRequests; },
    get writes() { return writes; }, get failedLists() { return failedLists; }, get socketMessages() { return socketMessages; },
    failLists() { failLists = true; },
    publish() { manager.emit('session:activity', sessions[0]); },
    async close() {
      await context.close();
      wss.clients.forEach(client => client.terminate()); wss.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    } };
}

async function status(browser) {
  const f = await fixture(browser);
  try {
    await f.page.locator('.message.assistant').waitFor();
    assert.equal(await f.page.locator('.unread-badge').textContent(), '1');
    assert.equal(await f.page.locator('.working-badge').textContent(), '1');
    const before = f.socketMessages;
    const failed = f.page.waitForResponse(r => new URL(r.url()).pathname === '/api/sessions' && r.status() === 503);
    f.failLists();
    await failed; await f.page.waitForTimeout(100);
    assert.equal(f.socketMessages, before, 'No new event may rescue the counters after the failed HTTP read');
    assert.equal(await f.page.locator('.unread-badge').count(), 1, 'HTTP failure cannot hide an unread reply while notifications remain connected');
    assert.equal(await f.page.locator('.working-badge').count(), 1, 'HTTP failure cannot hide a working task while notifications remain connected');
    if (process.env.HUB_REFRESH_SCREENSHOT) {
      await f.page.getByRole('button', { name: '会话列表', exact: true }).click();
      await f.page.setViewportSize({ width: 1100, height: 760 });
      await f.page.locator('.sidebar').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const filename = path.resolve(process.env.HUB_REFRESH_SCREENSHOT);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await f.page.screenshot({ path: filename });
    }
    // The existing shared-state route also remains authoritative during the
    // list outage: another device's read clears only the corresponding unread.
    f.manager.sync.apply({ type: 'read', name: 'unread', createdAt, completed: 'unread:done', contentRevision: 'unread:r1' });
    await f.page.locator('.unread-badge').waitFor({ state: 'detached', timeout: 1000 });
    assert.equal(await f.page.locator('.working-badge').textContent(), '1');
    assert.equal(f.writes, 0);
    assert(f.failedLists > 0); assert.deepEqual(f.errors, []);
    console.log('PASS status: HTTP 503 preserves server-confirmed counters without a new event; shared read still arrives over WebSocket; no cached content or input');
  } finally { await f.close(); }
}

async function content(browser) {
  const f = await fixture(browser, true);
  try {
    while (!f.answerRequests) await pause(10);
    // Keep content changing as well as phase: a slow read must make progress
    // even if it cannot contain the latest version at every instant.
    for (let i = 0; i < 12; i++) {
      f.sessions[0].activity = { ...f.sessions[0].activity, phase: i % 2 ? 'thinking' : 'executing', contentRevision: `reader:r${i + 2}` };
      f.publish(); await f.page.waitForTimeout(250);
    }
    assert.equal(await f.page.locator('.message[data-message-id="progress"]').count(), 1,
      'A 1.8-second answer must render while phase/version events continue every 250 ms');
    assert(f.answers <= 4, `Phase updates must share the in-flight read, got ${f.answers} requests`);
    f.sessions[0].activity = { ...f.sessions[0].activity, busy: false, phase: 'completed', completed: 'reader:done', contentRevision: 'reader:final' };
    f.publish();
    await f.page.locator('.message[data-message-id="final"]').waitFor({ timeout: 1000 });
    assert.equal(await f.page.locator('.mobile-reading').getAttribute('data-content-revision'), 'reader:final');
    assert.equal(await f.page.locator('.inline-status').getAttribute('aria-label'), '已完成 · 未读');
    assert.equal(f.writes, 0); assert.deepEqual(f.errors, []);
    console.log(`PASS content: continuous phase/version changes allow slow progress to render; completion immediately reads final; requests=${f.answers}; no cached content or input`);
  } finally { await f.close(); }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] }), failures = [];
  try {
    for (const [name, run] of Object.entries({ status, content })) {
      if (process.env.HUB_REFRESH_CASE && process.env.HUB_REFRESH_CASE !== name) continue;
      try { await run(browser); }
      catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
    }
    assert.deepEqual(failures, [], 'Both independent refresh defects must be fixed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
