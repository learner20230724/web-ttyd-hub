// Isolate status transport, content rendering and optional disk caching. Synthetic data only.
const assert = require('node:assert/strict');
const express = require('express');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const contentResponse = require('../server/services/content-response');
const createdAt = '2026-10-18T00:00:00Z';
const make = name => ({ name, displayName: name, createdAt, shell: 'codex', status: 'running', activity: { available: true, busy: true, phase: 'working' } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(browser, { blockedStorage = false } = {}) {
  const sessions = [make('reader'), make('background')], manager = new EventEmitter();
  const app = express(); app.use(express.json());
  const held = []; let holdLists = false, version = 0, inputs = 0, lists = 0, longContent = false;
  app.get('/api/sessions', (_req, res) => {
    lists++;
    const data = structuredClone({ sessions });
    if (holdLists) held.push(() => { if (!res.destroyed) res.json(data); });
    else res.json(data);
  });
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.json({ ok: true }); });
  app.get('/api/sessions/:name/mobile', (req, res) => contentResponse(req, res, {
    ...(req.query.view === 'full' ? { text: `完整终端 ${req.params.name} 版本 ${version}` }
      : { messages: [{ id: 'progress', role: 'assistant', phase: 'commentary', text: `精简回答 ${req.params.name} 版本 ${version}` + (longContent ? '\n\n' + '用于检查阅读位置的历史内容。\n\n'.repeat(60) : '') }] }),
    completed: sessions.find(s => s.name === req.params.name).activity.completed || null,
  }));
  app.use(express.static(path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager); await once(server, 'listening');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ createdAt, blockedStorage }) => {
    localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt }));
    if (blockedStorage) Object.defineProperty(window, 'indexedDB', { value: { open: () => ({}) } });
  }, { createdAt, blockedStorage });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.mobile-session-title').waitFor();
  await pause(100);
  return {
    page, sessions, manager, held, context,
    get inputs() { return inputs; }, get lists() { return lists; },
    hold() { holdLists = true; },
    release() { holdLists = false; held.splice(0).forEach(send => send()); },
    complete(name, notify = true) {
      const session = sessions.find(s => s.name === name);
      session.activity = { available: true, busy: false, phase: 'completed', completed: `${name}:done` };
      if (notify) manager.emit('session:activity', session);
    },
    nextContent() { version++; },
    longContent() { longContent = true; version++; },
    async close() { await context.close(); wss.clients.forEach(ws => ws.terminate()); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const failures = [];
  async function experiment(name, options, run) {
    const f = await fixture(browser, options);
    try { await run(f); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
    finally { await f.close(); }
  }
  try {
    await experiment('baseline: background completion needs no click or message', {}, async f => {
      f.complete('background');
      await f.page.locator('.unread-badge').waitFor({ timeout: 2000 });
      assert.equal(f.inputs, 0);
    });
    await experiment('remove list-response dependency: completion applies while HTTP is held', {}, async f => {
      f.hold();
      await f.page.evaluate(() => window.dispatchEvent(new Event('online')));
      await pause(100);
      f.complete('background');
      await f.page.locator('.unread-badge').waitFor({ timeout: 1000 });
      f.release(); await pause(100);
      assert.equal(await f.page.locator('.unread-badge').textContent(), '1', 'A late pre-completion list cannot undo the event');
      assert.equal(f.inputs, 0);
    });
    await experiment('remove WebSocket delivery: periodic reconciliation recovers completion', {}, async f => {
      f.complete('background', false);
      await f.page.locator('.unread-badge').waitFor({ timeout: 6500 });
      assert.equal(f.inputs, 0);
    });
    await experiment('remove IndexedDB dependency: live answer/full remain usable', { blockedStorage: true }, async f => {
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor({ timeout: 1500 });
      await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
      await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor({ timeout: 1000 });
      await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor({ timeout: 500 });
    });
    await experiment('completion is unread until its content has actually rendered', {}, async f => {
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
      await f.context.route('**/api/sessions/reader/mobile**', () => {});
      f.complete('reader');
      await f.page.locator('.mobile-session-header .activity-badge.unread').waitFor({ timeout: 1000 });
      await f.page.waitForTimeout(1600);
      assert.equal(await f.page.locator('.mobile-session-header .activity-badge.unread').count(), 1, 'Old content cannot acknowledge a new completion');
      await f.context.unrouteAll({ behavior: 'ignoreErrors' });
      // A new request after remount must carry and render the matching completion.
      await f.page.reload();
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
      await f.page.locator('.mobile-session-header').getByText('已完成 · 已读', { exact: true }).waitFor();
      assert.equal(f.inputs, 0);
    });
    await experiment('reading older output does not acknowledge a newly completed reply', {}, async f => {
      f.longContent();
      await f.page.getByText(/精简回答 reader 版本 1/).waitFor();
      await f.page.locator('.mobile-reading').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      await f.page.getByRole('button', { name: '↓ 回到最新', exact: true }).waitFor();
      f.nextContent(); f.complete('reader');
      await f.page.getByText(/精简回答 reader 版本 2/).waitFor();
      assert.equal(await f.page.locator('.mobile-session-header .activity-badge.unread').count(), 1);
      await f.page.getByRole('button', { name: '↓ 回到最新', exact: true }).tap();
      await f.page.locator('.mobile-session-header').getByText('已完成 · 已读', { exact: true }).waitFor();
      assert.equal(f.inputs, 0);
    });
    await experiment('cached views switch immediately with network responses held', {}, async f => {
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
      await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
      await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor();
      await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await f.page.getByLabel('消息输入').fill('未发送的草稿');
      await f.context.route('**/api/sessions/reader/mobile**', () => {});
      for (let i = 0; i < 3; i++) {
        await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
        await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor({ timeout: 500 });
        await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
        await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor({ timeout: 500 });
      }
      assert.equal(await f.page.getByLabel('消息输入').inputValue(), '未发送的草稿');
      assert.equal(f.inputs, 0);
    });
    assert.deepEqual(failures, [], 'All ablation experiments must pass');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
