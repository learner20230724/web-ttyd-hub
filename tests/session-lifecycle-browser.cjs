// Real Vue rendering when a WebView rejects WebSocket construction. All API
// data is synthetic; no terminal, model, input or shared read write is involved.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright');
const createdAt = '2026-10-20T00:00:00Z';

(async () => {
  const make = (name, phase) => ({ name, createdAt, displayName: `合成会话 ${name}`, shell: 'codex', status: 'running',
    activity: { available: true, detected: true, phase, busy: phase === 'working', completed: phase === 'completed' ? `${name}:done` : null } });
  const sessions = [make('reader', 'completed'), make('done', 'completed'), make('worker', 'working')];
  let lists = 0, writes = 0;
  const app = express();
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { writes++; return res.sendStatus(405); }
    next();
  });
  app.get('/api/sessions', (_req, res) => { lists++; res.json({ sessions }); });
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.get('/api/sessions/:name/mobile', (req, res) => res.json({ ...(req.query.view === 'full'
    ? { text: 'SYNTHETIC_FULL_TOOL_OUTPUT' }
    : { messages: [{ id: 'answer', role: 'assistant', phase: 'final_answer', text: '合成回答：即使通知通道不可用，打开也直接显示。' }] }), completed: `${req.params.name}:done` }));
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ createdAt }) => {
      localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt }));
      window.__socketAttempts = 0;
      window.WebSocket = class { constructor() { window.__socketAttempts++; throw Error('Synthetic WebView rejected socket'); } };
    }, { createdAt });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(errors, [], 'A rejected notification transport cannot interrupt initial Vue rendering');
    await page.locator('.message.assistant').filter({ hasText: '合成回答：即使通知通道不可用' }).waitFor({ timeout: 1500 });
    assert.equal(await page.locator('.unread-badge').textContent(), '1');
    assert.equal(await page.locator('.working-badge').textContent(), '1');
    await page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
    await page.getByText('SYNTHETIC_FULL_TOOL_OUTPUT', { exact: true }).waitFor({ timeout: 1500 });
    await page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
    await page.locator('.message.assistant').filter({ hasText: '合成回答：即使通知通道不可用' }).waitFor({ timeout: 1500 });
    assert.equal(writes, 0);
    assert(lists >= 1);
    assert(await page.evaluate(() => window.__socketAttempts >= 1));
    assert.deepEqual(errors, []);
    console.log('PASS rejected WebSocket construction still renders initial answers, all task counters and both views without any input or API write');
    await context.close();
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
