// Isolate status transport, content rendering and optional disk caching. Synthetic data only.
const assert = require('node:assert/strict');
const express = require('express');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const SessionManager = require('../server/services/session-manager');
const sessionRoutes = require('../server/routes/sessions');
const createdAt = '2026-10-18T00:00:00Z';
const make = name => ({ name, displayName: name, createdAt, shell: 'codex', status: 'running', activity: { available: true, busy: true, phase: 'working' } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(browser, { blockedStorage = false, unavailableAnswers = false, cachedAnswer = null } = {}) {
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
  // Exercise the production route and view selection, not a fake endpoint that
  // is already guaranteed to return different data for each query string.
  manager.ensurePane = async () => {};
  manager.getSession = name => sessions.find(s => s.name === name);
  manager.activity = {
    messages: name => unavailableAnswers ? null : [{ id: 'progress', role: 'assistant', phase: 'commentary', text: `精简回答 ${name} 版本 ${version}` + (longContent ? '\n\n' + '用于检查阅读位置的历史内容。\n\n'.repeat(60) : '') }],
    inputReceipts: () => [],
  };
  manager.history = async name => ({ text: `完整终端 ${name} 版本 ${version}` });
  manager.mobile = SessionManager.prototype.mobile;
  app.use('/api/sessions', sessionRoutes(manager));
  app.get('/cache-seed', (_req, res) => res.send('<!doctype html><title>Cache fixture</title>'));
  app.use(express.static(path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager); await once(server, 'listening');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ createdAt, blockedStorage }) => {
    localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt }));
    if (blockedStorage) Object.defineProperty(window, 'indexedDB', { value: { open: () => ({}) } });
  }, { createdAt, blockedStorage });
  const page = await context.newPage();
  if (cachedAnswer) {
    await page.goto(`http://127.0.0.1:${server.address().port}/cache-seed`);
    await page.evaluate(async ({ data, createdAt }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ttyd-hub-content-v1', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('content', { keyPath: 'key' });
          request.result.createObjectStore('metadata', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const entry = { key: JSON.stringify(['reader', createdAt, 'answer']), sessionId: 'reader', generation: createdAt, data, used: Date.now(), bytes: JSON.stringify(data).length * 2 };
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['content', 'metadata'], 'readwrite');
        tx.objectStore('content').put(entry); tx.objectStore('metadata').put({ ...entry, data: undefined });
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, { data: cachedAnswer, createdAt });
    // Let the unavailable network reply win the race against the disk read.
    await page.addInitScript(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => new Proxy(open(...args), {
        get: (request, key) => Reflect.get(request, key, request),
        set(request, key, value) { request[key] = key === 'onsuccess' ? event => setTimeout(() => value(event), 250) : value; return true; },
      });
    });
  }
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
    answersAvailable(value) { unavailableAnswers = !value; },
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
    await experiment('missing Codex dialogue never makes answer and full modes identical', { unavailableAnswers: true }, async f => {
      await f.page.getByText('暂无可显示的回答', { exact: true }).waitFor();
      assert.equal(await f.page.locator('.mobile-output').count(), 0);
      await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
      await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor();
      await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await f.page.getByText('暂无可显示的回答', { exact: true }).waitFor();
      assert.equal(await f.page.locator('.mobile-output').count(), 0);
      f.answersAvailable(true);
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
      f.answersAvailable(false);
      await f.page.waitForTimeout(1600);
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
      assert.equal(await f.page.locator('.mobile-output').count(), 0, 'An observer gap keeps the last answer, not terminal output');
      f.answersAvailable(true); f.nextContent();
      await f.page.getByText('精简回答 reader 版本 1', { exact: true }).waitFor();
      assert.equal(f.inputs, 0);
    });
    for (const legacy of [false, true]) await experiment(legacy ? 'legacy disk terminal output is never rendered as a Codex answer' : 'cold start preserves the last valid disk answer during an observer gap', {
      unavailableAnswers: true,
      cachedAnswer: legacy ? { text: '旧版误存的终端全文' } : { messages: [{ id: 'saved', role: 'assistant', text: '之前已读过的回答' }], completed: 'previous-turn' },
    }, async f => {
      await f.page.getByText(legacy ? '暂无可显示的回答' : '之前已读过的回答', { exact: true }).waitFor();
      await f.page.waitForTimeout(700);
      assert.equal(await f.page.locator('.mobile-output').count(), 0);
      assert.equal(await f.page.getByText('旧版误存的终端全文', { exact: true }).count(), 0);
      f.answersAvailable(true);
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
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
