// Isolate status transport, content rendering and optional disk caching. Synthetic data only.
const assert = require('node:assert/strict');
const express = require('express');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const SessionManager = require('../server/services/session-manager');
const sessionRoutes = require('../server/routes/sessions');
const SessionSync = require('../server/services/session-sync');
const { CodexActivity } = require('../server/services/codex-activity');
const { resolveRollout } = require('../server/services/codex-observer');
const createdAt = '2026-10-18T00:00:00Z';
const make = name => ({ name, displayName: name, createdAt, shell: 'codex', status: 'running', activity: { available: true, busy: true, phase: 'working' } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(browser, { blockedStorage = false, unavailableAnswers = false, emptyAnswers = false, shell = 'codex', cachedAnswer = null, sharedSync = false, footerFailure = false, titleBinding = false } = {}) {
  const sessions = [make('reader'), make('background')], manager = new EventEmitter();
  sessions.forEach(session => {
    session.shell = shell;
    if (unavailableAnswers) session.activity = { available: false, detected: shell === 'codex', busy: false, phase: 'unknown', completed: null };
  });
  if (sharedSync) {
    manager.sessions = new Map(sessions.map(s => [s.name, s]));
    manager.list = () => sessions;
    manager.sync = new SessionSync(manager);
    manager.sync.restore({ revision: 0, read: {}, layout: { order: ['reader', 'background'], pinned: [] } });
  }
  const app = express(); app.use(express.json());
  const held = []; let holdLists = false, version = 0, inputs = 0, lists = 0, longContent = false;
  app.get('/api/sessions', (_req, res) => {
    lists++;
    const data = structuredClone({ sessions, shared: manager.sync?.snapshot() });
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
    messages: name => unavailableAnswers ? null : emptyAnswers ? [] : [{ id: 'progress', role: 'assistant', phase: 'commentary', text: `精简回答 ${name} 版本 ${version}` + (longContent ? '\n\n' + '用于检查阅读位置的历史内容。\n\n'.repeat(60) : '') }],
    inputReceipts: () => [],
  };
  manager.history = async name => ({ text: `完整终端 ${name} 版本 ${version}` });
  let sourceDirectory, finishSource;
  if (footerFailure || titleBinding) {
    sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-reader-source-'));
    const directory = path.join(sourceDirectory, 'sessions', 'today');
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, 'rollout-fixture.jsonl');
    let observe = async () => ({ detected: true, path: filename });
    let metadata = '';
    if (titleBinding) {
      const { DatabaseSync } = require('node:sqlite');
      const project = path.join(sourceDirectory, 'project-name-longer-than-terminal-limit'), cwd = path.join(project, 'frontend', 'src');
      await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(path.join(project, '.git'));
      const database = path.join(sourceDirectory, 'state_5.sqlite'), db = new DatabaseSync(database);
      db.exec('CREATE TABLE threads (id TEXT, name TEXT, cwd TEXT)');
      db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('fixture', '对话'.repeat(25), cwd); db.close();
      metadata = JSON.stringify({ type: 'session_meta', payload: { id: 'fixture', source: 'cli', cwd } }) + '\n';
      observe = async () => ({ detected: true, path: await resolveRollout([filename, database],
        '⠋ ' + '对话'.repeat(22) + '对... | project-name-longer-t...', true) });
    }
    const row = (type, payload) => JSON.stringify({ type, timestamp: '2026-10-19T00:00:00Z', payload }) + '\n';
    const reply = (text, phase = 'commentary') => row('response_item', { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] });
    await fs.writeFile(filename, metadata + row('event_msg', { type: 'task_started', turn_id: 'one' }) +
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<send_user_message_question_reply>\n' +
        JSON.stringify([{ answer: '查看实际界面', question: '要看哪里？', questionItemId: 'transport-id-must-stay-hidden' }]) + '\n</send_user_message_question_reply>' }] }) +
      reply('正在检查阅读模式') + row('response_item', { type: 'custom_tool_call', call_id: 'build', name: 'exec', input: 'npm run build' }));
    manager.sessions = new Map(sessions.map(s => [s.name, s]));
    manager.serialize = s => s;
    manager.activity = new CodexActivity(manager, { observer: { observe } });
    clearInterval(manager.activity.timer);
    const pane = { pid: 'fixture', id: '=__hub_missing_footer_fixture__' };
    await manager.activity.update(sessions[0], pane);
    let finished = false;
    manager.history = async () => ({ text: '• 正在检查阅读模式\n• Ran npm run build\n  └ TOOL_OUTPUT_FIXTURE\n' + (finished ? '• 最终回复：检查完成。' : '') });
    finishSource = async () => {
      await fs.appendFile(filename, row('response_item', { type: 'custom_tool_call_output', call_id: 'build', output: 'TOOL_OUTPUT_FIXTURE' }) +
        reply('最终回复：检查完成。', 'final_answer') + row('event_msg', { type: 'task_complete', turn_id: 'one' }));
      finished = true;
      await manager.activity.update(sessions[0], pane);
    };
  }
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
    page, sessions, manager, held, context, finishSource,
    get inputs() { return inputs; }, get lists() { return lists; },
    hold() { holdLists = true; },
    allowNewLists() { holdLists = false; },
    release() { holdLists = false; held.splice(0).forEach(send => send()); },
    complete(name, notify = true) {
      const session = sessions.find(s => s.name === name);
      session.activity = { available: true, busy: false, phase: 'completed', completed: `${name}:done` };
      if (notify) manager.emit('session:activity', session);
    },
    nextContent() { version++; },
    longContent() { longContent = true; version++; },
    answersAvailable(value) {
      unavailableAnswers = !value;
      sessions[0].activity = { available: value, detected: shell === 'codex', busy: value, phase: value ? 'working' : 'unknown', completed: null };
    },
    async close() {
      await context.close(); wss.clients.forEach(ws => ws.terminate()); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (sourceDirectory) { manager.activity.close(); await fs.rm(sourceDirectory, { recursive: true, force: true }); }
    },
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
    for (const trigger of ['foreground', 'online']) await experiment(`${trigger} refreshes task states without waiting for a suspended list request`, {}, async f => {
      f.hold();
      await f.page.evaluate(() => window.dispatchEvent(new Event('online')));
      while (!f.held.length) await pause(20);
      f.complete('background', false); f.allowNewLists();
      if (trigger === 'online') await f.page.evaluate(() => window.dispatchEvent(new Event('online')));
      else await f.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await f.page.locator('.unread-badge').waitFor({ timeout: 1500 });
      f.release(); await pause(100);
      assert.equal(await f.page.locator('.unread-badge').textContent(), '1', 'A suspended old list cannot overwrite the fresh completion');
      assert.equal(f.inputs, 0);
    });
    await experiment('remote read and pin broadcasts apply even while every list response is held', { sharedSync: true }, async f => {
      f.complete('background');
      await f.page.locator('.unread-badge').waitFor({ timeout: 1500 });
      f.hold();
      await f.page.evaluate(() => window.dispatchEvent(new Event('online')));
      while (!f.held.length) await pause(20);
      f.manager.sync.apply({ type: 'read', name: 'background', createdAt, completed: 'background:done' });
      f.manager.sync.apply({ type: 'pin', name: 'background', createdAt, pinned: true });
      await f.page.locator('.unread-badge').waitFor({ state: 'hidden', timeout: 1500 });
      await f.page.locator('[data-session-id="background"].pinned').waitFor({ state: 'attached', timeout: 1500 });
      f.release(); await pause(100);
      assert.equal(await f.page.locator('.unread-badge').count(), 0);
      assert.equal(f.inputs, 0);
    });
    await experiment('remove IndexedDB dependency: live answer/full remain usable', { blockedStorage: true }, async f => {
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor({ timeout: 1500 });
      await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
      await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor({ timeout: 1000 });
      await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor({ timeout: 500 });
    });
    for (const titleBinding of [false, true]) await experiment(titleBinding
      ? 'truncated nested-project title discovers the final answer and completion without input'
      : 'verified dialogue survives a failed footer capture and still differs from full execution output',
    titleBinding ? { titleBinding: true } : { footerFailure: true }, async f => {
      await f.page.locator('.message.assistant').filter({ hasText: '正在检查阅读模式' }).waitFor({ timeout: 1500 });
      assert.equal(await f.page.locator('.message.user .markdown').innerText(), '查看实际界面');
      assert(!/send_user_message_question_reply|transport-id/.test(await f.page.locator('.mobile-reading').innerText()));
      await f.finishSource();
      await f.page.locator('.message.assistant').filter({ hasText: '最终回复：检查完成。' }).waitFor({ timeout: 1500 });
      assert.match(await f.page.locator('.mobile-session-header').innerText(), /已完成/);
      const reading = f.page.locator('.mobile-reading');
      assert(!/TOOL_OUTPUT_FIXTURE|npm run build/.test(await reading.innerText()));
      await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
      await f.page.getByText(/TOOL_OUTPUT_FIXTURE[\s\S]*最终回复：检查完成。/).waitFor({ timeout: 1500 });
      assert.match(await reading.innerText(), /npm run build/);
      assert.equal(await f.page.locator('.message').count(), 0);
      await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await f.page.locator('.message.assistant').filter({ hasText: '最终回复：检查完成。' }).waitFor({ timeout: 500 });
      assert(!/TOOL_OUTPUT_FIXTURE|npm run build/.test(await reading.innerText()));
      assert.equal(f.inputs, 0);
    });
    await experiment('missing dialogue never takes ownership of the reading toggle', { unavailableAnswers: true }, async f => {
      await f.page.locator('.answer-placeholder').waitFor({ timeout: 2000 });
      assert.equal(await f.page.locator('.mobile-output').count(), 0, 'Answer mode cannot masquerade as full output');
      const toggle = f.page.locator('.reading-control[aria-pressed]');
      for (const full of [true, false, true, false]) {
        await toggle.tap();
        assert.equal(await toggle.getAttribute('aria-pressed'), String(full));
        assert.equal(await toggle.textContent(), full ? '全文' : '回答');
        assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('web-ttyd-hub.mobile-reading.v1')).showExecution), full);
        if (full) await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor({ timeout: 1000 });
        else {
          await f.page.locator('.answer-placeholder').waitFor({ timeout: 1000 });
          assert.equal(await f.page.locator('.mobile-output').count(), 0);
        }
      }
      f.answersAvailable(true);
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
      assert.equal(await toggle.textContent(), '回答');
      await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
      await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor();
      await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
      f.answersAvailable(false); f.nextContent();
      await f.page.locator('.answer-placeholder').waitFor({ timeout: 2000 });
      assert.equal(await f.page.getByText('精简回答 reader 版本 0', { exact: true }).count(), 1, 'A source gap preserves a final reply already fetched');
      assert.equal(await f.page.locator('.mobile-output').count(), 0);
      assert.equal(await toggle.textContent(), '回答');
      await toggle.tap();
      await f.page.getByText('完整终端 reader 版本 1', { exact: true }).waitFor({ timeout: 1000 });
      await toggle.tap();
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor({ timeout: 1000 });
      f.answersAvailable(true);
      await f.page.getByText('精简回答 reader 版本 1', { exact: true }).waitFor();
      assert.equal(await toggle.textContent(), '回答');
      assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('web-ttyd-hub.mobile-reading.v1')).showExecution), false);
      assert.equal(f.inputs, 0);
    });
    await experiment('a bound empty thread has a genuine empty answer state', { emptyAnswers: true }, async f => {
      await f.page.getByText('此会话还没有回答。', { exact: true }).waitFor({ timeout: 1500 });
      assert.equal(await f.page.locator('.mobile-output').count(), 0);
      await f.page.locator('.answer-placeholder').getByRole('button', { name: '查看全文', exact: true }).tap();
      await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor({ timeout: 1000 });
      assert.equal(f.inputs, 0);
    });
    await experiment('ordinary shells keep readable terminal output in either view', { unavailableAnswers: true, shell: 'bash' }, async f => {
      await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor({ timeout: 1500 });
      assert.equal(await f.page.locator('.answer-placeholder').count(), 0);
      await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
      await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor({ timeout: 1000 });
      assert.equal(f.inputs, 0);
    });
    for (const legacy of [false, true]) await experiment(legacy ? 'old disk terminal output is never presented as an answer' : 'source gaps preserve access to current terminal output without labelling it an answer', {
      unavailableAnswers: true,
      cachedAnswer: legacy ? { text: '旧版误存的终端全文' } : { messages: [{ id: 'saved', role: 'assistant', text: '之前已读过的回答' }], completed: 'previous-turn' },
    }, async f => {
      await f.page.locator('.answer-placeholder').waitFor({ timeout: 2000 });
      await f.page.waitForTimeout(700);
      assert.equal(await f.page.locator('.mobile-output').count(), 0);
      assert.equal(await f.page.getByText('旧版误存的终端全文', { exact: true }).count(), 0);
      await f.page.locator('.answer-placeholder').getByRole('button', { name: '查看全文', exact: true }).tap();
      await f.page.getByText('完整终端 reader 版本 0', { exact: true }).waitFor({ timeout: 1000 });
      await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      f.answersAvailable(true);
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
    });
    for (const trigger of ['completion', 'foreground', 'switch']) await experiment(`${trigger} retrieves the final answer despite a suspended earlier request`, {}, async f => {
      await f.page.getByText('精简回答 reader 版本 0', { exact: true }).waitFor();
      let first = true, held;
      const heldRequest = new Promise(resolve => { held = resolve; });
      await f.context.route('**/api/sessions/reader/mobile', route => {
        if (first) { first = false; held(); return; }
        return route.continue();
      });
      await heldRequest;
      f.nextContent();
      if (trigger === 'completion') f.complete('reader');
      else if (trigger === 'foreground') await f.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      else {
        await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
        await f.page.getByText(/完整终端 reader/).waitFor();
        await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      }
      await f.page.getByText('精简回答 reader 版本 1', { exact: true }).waitFor({ timeout: 1500 });
      assert.equal(f.inputs, 0);
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
      const toggle = f.page.locator('.reading-control[aria-pressed]');
      assert.equal(await toggle.count(), 1, 'Keep the original single toggle');
      assert.equal(await toggle.textContent(), '回答');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
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
        assert.equal(await toggle.textContent(), '回答');
        assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      }
      assert.equal(await f.page.getByLabel('消息输入').inputValue(), '未发送的草稿');
      assert.equal(f.inputs, 0);
    });
    assert.deepEqual(failures, [], 'All ablation experiments must pass');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
