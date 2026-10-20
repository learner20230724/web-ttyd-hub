// Exercise real durable caches across new page processes, with synthetic data.
// The offline interval blocks both status transports; static assets stay served
// so this specifically tests metadata/content reuse instead of browser HTTP cache.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const SessionSync = require('../server/services/session-sync');

(async () => {
  const createdAt = '2026-10-20T00:00:00Z';
  const session = { name: 'local-reader', displayName: '本地缓存合成会话', createdAt, shell: 'codex', status: 'running',
    activity: { available: true, detected: true, phase: 'completed', busy: false, completed: 'cache-one' } };
  const manager = new EventEmitter(); manager.sessions = new Map([[session.name, session]]);
  manager.list = () => [session]; manager.sync = new SessionSync(manager);
  manager.sync.restore({ revision: 1, read: { [session.name]: { createdAt, completed: 'cache-one' } }, layout: { order: [session.name], pinned: [] } });
  const app = express(); app.use(express.json());
  let holdLists = false, blockSockets = false, answerRequests = 0, fullRequests = 0, inputs = 0;
  const lists = [];
  app.get('/api/sessions', (_req, res) => {
    const send = () => { if (!res.destroyed) res.json({ sessions: [session], shared: manager.sync.snapshot() }); };
    if (holdLists) lists.push(send); else send();
  });
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/mobile', (req, res) => {
    if (req.query.view === 'full') {
      fullRequests++;
      res.json({ text: '合成全文缓存：EXECUTION_LOG_ONLY_IN_FULL', completed: session.activity.completed });
    } else {
      answerRequests++;
      res.json({ messages: [{ id: 'cached-answer', role: 'assistant', phase: 'final_answer', text: '合成回答缓存：关闭页面后仍然可以直接阅读。' }], completed: session.activity.completed });
    }
  });
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.json({ ok: true }); });
  app.post('/api/sessions/sync', (req, res) => res.json(manager.sync.apply(req.body)));
  app.use(express.static(path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager); await once(server, 'listening');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ name, createdAt }) => {
      if (!localStorage.getItem('web-ttyd-hub.last-session.v1')) localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name, createdAt }));
    }, { name: session.name, createdAt });
    await context.routeWebSocket('**/ws', route => { if (blockSockets) route.close(); else route.connectToServer(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    let page = await context.newPage(); await page.goto(url);
    await page.locator('.message.assistant').filter({ hasText: '合成回答缓存' }).waitFor({ timeout: 1500 });
    const settledAnswers = answerRequests;
    await page.waitForTimeout(2800);
    assert.equal(fullRequests, 0, 'Answer readers must not silently download full terminal logs');
    assert.equal(answerRequests, settledAnswers, 'Completed sessions do not repeat a history request every 1.2 seconds');
    console.log('PASS answer-only opening never downloads unseen full logs, completed histories stop rapid polling');
    await page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
    await page.getByText(/EXECUTION_LOG_ONLY_IN_FULL/).waitFor({ timeout: 1500 });
    assert.equal(fullRequests, 1, 'First opening full view fetches it once');
    await page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
    await page.locator('.message.assistant').filter({ hasText: '合成回答缓存' }).waitFor({ timeout: 1500 });
    await page.waitForTimeout(700); await page.close();
    holdLists = true; blockSockets = true;
    const beforeOffline = { answer: answerRequests, full: fullRequests };
    page = await context.newPage(); await page.goto(url);
    await page.locator('.message.assistant').filter({ hasText: '合成回答缓存' }).waitFor({ timeout: 1500 });
    await page.locator('.mobile-session-header').getByText('本地缓存', { exact: true }).waitFor({ timeout: 1500 });
    assert.equal(await page.locator('.composer .send').isDisabled(), true, 'Cached names cannot accept inputs before the server confirms their generation');
    assert.deepEqual({ answer: answerRequests, full: fullRequests }, beforeOffline, 'Cold cache rendering does not request histories before generation validation');
    await page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
    await page.getByText(/EXECUTION_LOG_ONLY_IN_FULL/).waitFor({ timeout: 1500 });
    assert.deepEqual({ answer: answerRequests, full: fullRequests }, beforeOffline, 'Both cached views remain available without status or history transport');
    assert.equal(inputs, 0);
    console.log('PASS cold new page renders both disk views with status transports held, no history request and no input');
    holdLists = false; lists.splice(0).forEach(send => send());
    await page.locator('.mobile-session-header').getByText('本地缓存', { exact: true }).waitFor({ state: 'detached', timeout: 1500 });
    await page.waitForFunction(() => !document.querySelector('.composer .send')?.disabled);
    // Opening the socket resumes immediate work updates; completed sessions
    // still refresh immediately when their task phase changes.
    blockSockets = false; await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(150);
    const beforeWorking = fullRequests;
    session.activity = { available: true, detected: true, phase: 'executing', busy: true, completed: null };
    manager.emit('session:activity', session);
    await page.locator('.mobile-session-header').getByText('执行中', { exact: true }).waitFor({ timeout: 1500 });
    await page.waitForFunction(() => document.querySelector('.mobile-session-header')?.textContent.includes('执行中'));
    await page.waitForTimeout(1400);
    assert(fullRequests >= beforeWorking + 2, 'Active task phases immediately fetch and continue fast reconciliation');
    assert.equal(inputs, 0);
    console.log('PASS authoritative list validates cache and working task changes resume immediate/fast refresh without sending input');
    await context.close();
  } finally {
    await browser.close(); wss.clients.forEach(client => client.terminate()); wss.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
