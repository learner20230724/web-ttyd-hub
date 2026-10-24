// A real rejected WebSocket upgrade must not hide HTTP-confirmed task states.
// Synthetic sessions only. Reading/reconnecting never submits terminal input.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { chromium } = require('playwright');
const createdAt = '2026-10-24T00:00:00Z';

(async () => {
  const make = (name, phase) => ({ name, createdAt, shell: 'codex', status: 'running',
    activity: { detected: true, available: true, busy: phase === 'working', phase,
      completed: phase === 'completed' ? `${name}:complete` : null } });
  const sessions = [make('reader', 'completed'), make('first-unread', 'completed'), make('second-unread', 'completed'), make('worker', 'working')];
  let upgrades = 0, lists = 0, writes = 0;
  const app = express();
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) { writes++; return res.sendStatus(405); }
    next();
  });
  app.get('/api/sessions', (_req, res) => {
    lists++;
    setTimeout(() => { if (!res.destroyed) res.json({ sessions }); }, 150);
  });
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.get('/api/sessions/:name/mobile', (req, res) => res.json({ ...(req.query.view === 'full'
    ? { text: 'SYNTHETIC_TERMINAL_FULL_OUTPUT' }
    : { messages: [{ id: 'answer', role: 'assistant', phase: 'final_answer', text: '合成回答：通知连接失败时仍保持已验证的任务状态。' }] }), completed: `${req.params.name}:complete` }));
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1');
  server.on('upgrade', (_req, socket) => {
    upgrades++;
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await once(server, 'listening');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ createdAt }) => {
      localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt }));
      document.hasFocus = () => false;
    }, { createdAt });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.message.assistant').filter({ hasText: '合成回答：通知连接失败时' }).waitFor({ timeout: 2000 });
    await page.waitForFunction(() => document.querySelector('.unread-badge')?.textContent === '2' && document.querySelector('.working-badge')?.textContent === '1');
    await page.evaluate(() => {
      window.__counterRegressions = [];
      window.__counterObserver = new MutationObserver(() => {
        const unread = document.querySelector('.unread-badge')?.textContent;
        const working = document.querySelector('.working-badge')?.textContent;
        if (unread !== '2' || working !== '1') window.__counterRegressions.push({ unread, working });
      });
      window.__counterObserver.observe(document.querySelector('.toolbar'), { childList: true, subtree: true, characterData: true });
    });
    // Observe several real close/reconnect events, spanning the ordinary HTTP
    // reconciliation interval. Neither typing nor clicks can rescue the state.
    if (process.env.HUB_AUDIT_BEFORE) {
      await page.waitForFunction(() => window.__counterRegressions.length > 0, { timeout: 5500 });
    } else await page.waitForTimeout(5500);
    if (process.env.HUB_AUDIT_COUNTER_SCREENSHOT) {
      const filename = path.resolve(process.env.HUB_AUDIT_COUNTER_SCREENSHOT);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await page.screenshot({ path: filename });
    }
    if (!process.env.HUB_AUDIT_BEFORE) {
      assert(upgrades >= 3, `Expected repeated rejected handshakes, got ${upgrades}`);
      assert(lists >= 2, 'HTTP independently reconciles while notifications fail');
    }
    assert.deepEqual(await page.evaluate(() => window.__counterRegressions), [], 'A notification close cannot erase freshly verified counters');
    assert.equal(await page.locator('.unread-badge').textContent(), '2');
    assert.equal(await page.locator('.working-badge').textContent(), '1');
    assert.equal(writes, 0);
    assert.deepEqual(errors, []);
    console.log('PASS repeated 401 WebSocket handshakes preserve two unread replies and one working task without clicks, input or API writes');
    await context.close();
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
