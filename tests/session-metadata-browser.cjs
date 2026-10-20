// Cold page processes use durable metadata, never fake a fresh task status or
// mark a cached completion read. All API, messages and shared state are synthetic.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const SessionSync = require('../server/services/session-sync');
const createdAt = '2026-10-20T00:00:00Z';

(async () => {
  const sessions = [
    { name: 'reader', displayName: '缓存的合成会话', createdAt, shell: 'codex', status: 'running', activity: { available: true, phase: 'completed', busy: false, completed: 'first-answer' } },
    { name: 'background', displayName: '缓存的另一个会话', createdAt, shell: 'codex', status: 'running', activity: { available: true, phase: 'working', busy: true } },
  ];
  const manager = new EventEmitter(); manager.sessions = new Map(sessions.map(s => [s.name, s]));
  manager.list = () => [...manager.sessions.values()];
  manager.sync = new SessionSync(manager);
  manager.sync.restore({ revision: 3, read: {}, layout: { order: ['background', 'reader'], pinned: ['background'] } });
  const app = express(); app.use(express.json());
  let held = false, blockSockets = false, readWrites = 0, inputs = 0, shellRequests = 0;
  const pending = [];
  app.get('/api/sessions', (_req, res) => {
    const send = () => { if (!res.destroyed) res.json({ sessions: manager.list(), shared: manager.sync.snapshot() }); };
    if (held) pending.push(send); else send();
  });
  app.get('/api/sessions/shells', (_req, res) => { shellRequests++; res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }); });
  app.post('/api/sessions/sync', async (req, res) => {
    if (req.body.type === 'read') readWrites++;
    res.json(manager.sync.apply(req.body));
  });
  app.get('/api/sessions/:name/mobile', (req, res) => res.json({ messages: [{ id: 'answer', role: 'assistant', phase: 'final_answer', text: '合成本地历史回答' }], completed: manager.sessions.get(req.params.name)?.activity.completed || null }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.json({ ok: true }); });
  app.use(express.static(path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager); await once(server, 'listening');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const mobile of [true, false]) {
      held = false; blockSockets = false;
      const context = await browser.newContext({ viewport: mobile ? { width: 412, height: 915 } : { width: 1200, height: 800 }, isMobile: mobile, hasTouch: mobile });
      await context.addInitScript(({ createdAt }) => {
        if (!localStorage.getItem('web-ttyd-hub.last-session.v1')) localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt }));
      }, { createdAt });
      await context.routeWebSocket('**/ws', route => { if (blockSockets) route.close(); else route.connectToServer(); });
      let page = await context.newPage();
      const url = `http://127.0.0.1:${server.address().port}`;
      await page.goto(url);
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('web-ttyd-hub.session-metadata.v1'))?.sessions.length === 2);
      assert.equal(await page.locator('[data-session-id="background"].pinned').count(), 1);
      await page.close(); // Discard the page process and its memory cache.
      held = true; blockSockets = true;
      const writesBefore = readWrites;
      page = await context.newPage();
      await page.goto(url);
      await page.locator('[data-session-id="reader"].active').waitFor({ state: 'attached', timeout: 1500 });
      assert.equal(await page.locator('[data-session-id="background"].pinned').count(), 1);
      await page.locator('[data-session-id="reader"]').getByText('本地缓存', { exact: true }).waitFor({ state: 'attached', timeout: 1500 });
      assert.equal(await page.locator('.activity-badge.unread, .activity-badge.busy').count(), 0, 'Disk snapshots cannot pretend to be live completion or work');
      await page.waitForTimeout(700);
      assert.equal(readWrites, writesBefore, 'Opening a cached session never writes a shared read receipt');
      assert.equal(inputs, 0);
      assert(shellRequests > 0);
      // A list received without any user message restores live states.
      sessions[0].activity = { available: true, phase: 'responding', busy: true, completed: null };
      held = false; pending.splice(0).forEach(send => send());
      await page.locator('[data-session-id="reader"] .activity-badge.busy').first().waitFor({ state: 'attached', timeout: 1500 });
      assert.equal(await page.getByText('本地缓存', { exact: true }).count(), 0);
      // Reusing a server-side name must not silently reopen the replacement.
      await page.close(); held = true;
      sessions[0].createdAt = createdAt;
      page = await context.newPage(); await page.goto(url);
      await page.locator('[data-session-id="reader"].active').waitFor({ state: 'attached', timeout: 1500 });
      sessions[0].createdAt = createdAt + ':replacement';
      held = false; pending.splice(0).forEach(send => send());
      await page.locator('[data-session-id="reader"].active').waitFor({ state: 'detached', timeout: 1500 });
      assert.equal(inputs, 0);
      await page.close(); held = true;
      page = await context.newPage(); await page.goto(url);
      await page.locator('[data-session-id="reader"]').waitFor({ state: 'attached', timeout: 1500 });
      if (mobile) {
        assert.equal(await page.getByRole('button', { name: '会话列表', exact: true }).getAttribute('aria-expanded'), 'true',
          'Synchronous cache hydration without a selected session immediately opens the restored list');
        await page.locator('[data-session-id="reader"]').waitFor({ state: 'visible', timeout: 1500 });
      }
      await context.close();
      sessions[0].createdAt = createdAt;
      console.log(`PASS ${mobile ? 'phone' : 'desktop'} cold reopen restores selection/list/pins before network, shows cached status without reads, then reconciles and rejects replacement generations`);
    }
  } finally {
    await browser.close(); wss.clients.forEach(client => client.terminate()); wss.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
