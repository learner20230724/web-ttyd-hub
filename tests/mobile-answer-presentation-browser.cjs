// Real Vue renderer with synthetic HTTP data. Distinguish source availability,
// cached readable dialogue and actual transport failures without terminal input.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const SessionSync = require('../server/services/session-sync');
const contentResponse = require('../server/services/content-response');

const createdAt = '2026-10-24T00:00:00Z';
const savedReply = '合成已取得回答：这条完整回复不应同时显示读取失败。';
const fullDetail = 'SYNTHETIC_TOOL_DETAIL_ONLY_IN_FULL';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await predicate()) return; await pause(25); }
  throw Error('Timed out: ' + label);
}

async function fixture(browser, initialMode = 'structured', initialPhase = 'final_answer') {
  const session = { name: 'answer-fixture', displayName: '回答展示合成会话', createdAt, shell: 'codex', status: 'running',
    activity: { available: true, detected: true, busy: false, phase: 'completed', completed: 't1' } };
  const manager = new EventEmitter(); manager.sessions = new Map([[session.name, session]]);
  manager.list = () => [...manager.sessions.values()]; manager.sync = new SessionSync(manager);
  manager.sync.restore({ revision: 1, read: { [session.name]: { createdAt, completed: 't1' } },
    layout: { order: [session.name], pinned: [] } });
  let mode = initialMode, phase = initialPhase, reply = savedReply;
  let answerRequests = 0, fallbackResponses = 0, inputs = 0;
  const writes = [], reads = [];
  const app = express(); app.use(express.json());
  app.get('/api/sessions', (_req, res) => res.json({ sessions: manager.list(), shared: manager.sync.snapshot() }));
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.get('/api/sessions/:name/mobile', (req, res) => {
    assert.equal(req.params.name, session.name);
    assert.equal(req.headers['x-ttyd-generation'], createdAt);
    const completed = session.activity.completed;
    if (req.query.view === 'full') return contentResponse(req, res, { text: fullDetail + '\n' + reply, completed });
    answerRequests++;
    if (mode === 'failure') return res.status(500).json({ error: 'Synthetic answer HTTP failure' });
    if (mode === 'fallback') {
      fallbackResponses++;
      return contentResponse(req, res, { text: fullDetail + '\n' + reply, completed });
    }
    contentResponse(req, res, { messages: [{ id: 'stable-message-id', role: 'assistant', phase, text: reply }], completed });
  });
  app.post('/api/sessions/sync', (req, res) => {
    writes.push(req.body.type);
    assert.equal(req.body.type, 'read', 'The only permitted fixture write is a synthetic read receipt');
    reads.push(req.body); res.json(manager.sync.apply(req.body));
  });
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.sendStatus(405); });
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager); await once(server, 'listening');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ name, createdAt }) => {
    localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name, createdAt }));
    localStorage.setItem('web-ttyd-hub.shared-migrated.v1', '1');
    Object.defineProperty(document, 'hasFocus', { value: () => true });
  }, { name: session.name, createdAt });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.mobile-session-title').waitFor({ timeout: 3000 });
  return {
    page, reads, writes, errors, manager,
    get inputs() { return inputs; }, get answerRequests() { return answerRequests; }, get fallbackResponses() { return fallbackResponses; },
    setMode(value) { mode = value; },
    setPhase(value) { phase = value; },
    setReply(value) { reply = value; },
    complete(token) {
      session.activity = { ...session.activity, completed: token };
      manager.emit('session:activity', session);
    },
    refresh() { return page.evaluate(() => window.dispatchEvent(new Event('online'))); },
    async advanceClock() {
      await page.evaluate(() => { const original = Date.now; Date.now = () => original() + 20000; });
      await page.waitForTimeout(1100); // Let the existing one-second UI clock observe the new time.
    },
    async close() {
      assert.equal(inputs, 0, 'Answer/status verification must never submit terminal input');
      assert.deepEqual(errors, []);
      await context.close(); wss.clients.forEach(client => client.terminate()); wss.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    },
  };
}

async function readableCache(browser) {
  const f = await fixture(browser);
  try {
    await f.page.getByText(savedReply, { exact: true }).waitFor({ timeout: 2000 });
    f.setMode('fallback'); await f.refresh();
    await until(() => f.fallbackResponses > 0, 'successful terminal fallback');
    await f.advanceClock();
    assert.equal(await f.page.getByText(savedReply, { exact: true }).count(), 1);
    assert.equal(await f.page.locator('.answer-placeholder').count(), 0,
      'A visible retained structured reply must not also display an unavailable/failure placeholder');
    assert.doesNotMatch(await f.page.locator('.mobile-reading').innerText(), /暂时无法读取回答|正在自动重试|SYNTHETIC_TOOL_DETAIL_ONLY_IN_FULL/);
  } finally { await f.close(); }
}

async function successfulFallback(browser) {
  const f = await fixture(browser, 'fallback');
  try {
    await until(() => f.fallbackResponses > 0, 'first successful fallback');
    await f.advanceClock();
    await f.page.getByText('对话记录尚未就绪，可先查看全文。', { exact: true }).waitFor({ timeout: 1500 });
    assert.doesNotMatch(await f.page.locator('.mobile-reading').innerText(), /读取失败|暂时无法读取回答|正在自动重试/);
    assert.equal(await f.page.locator('.terminal-segments').count(), 0, 'Raw execution output cannot masquerade as an answer');
    await f.page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
    await f.page.getByText(new RegExp(fullDetail)).waitFor({ timeout: 1500 });
    assert.equal(await f.page.locator('.message').count(), 0);
    await f.page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
    await f.page.getByText('对话记录尚未就绪，可先查看全文。', { exact: true }).waitFor({ timeout: 1500 });
  } finally { await f.close(); }
}

async function actualFailure(browser) {
  const f = await fixture(browser, 'failure');
  try {
    await f.page.getByText('暂时无法读取回答，正在自动重试。', { exact: true }).waitFor({ timeout: 2000 });
    await until(() => f.answerRequests >= 2, 'a real failed request automatically retries');
    assert.equal(await f.page.locator('.message').count(), 0);
    assert.equal(await f.page.getByText('对话记录尚未就绪，可先查看全文。', { exact: true }).count(), 0);
    f.setMode('structured'); await f.refresh();
    await f.page.getByText(savedReply, { exact: true }).waitFor({ timeout: 2000 });
    await until(async () => await f.page.locator('.answer-placeholder, .mobile-error').count() === 0, 'a recovered request clears its error');
  } finally { await f.close(); }
}

async function messagePhase(browser) {
  const f = await fixture(browser, 'structured', 'commentary');
  try {
    await f.page.locator('.message.assistant .speaker').getByText('Codex · 工作进展', { exact: true }).waitFor({ timeout: 2000 });
    f.setPhase('final_answer'); await f.refresh();
    await f.page.locator('.message.assistant .speaker').getByText('Codex · 回复', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await f.page.getByText(savedReply, { exact: true }).count(), 1, 'The same message ID/text remains present when only its phase changes');
  } finally { await f.close(); }
}

async function retainedReadGuard(browser) {
  const f = await fixture(browser);
  try {
    await f.page.getByText(savedReply, { exact: true }).waitFor({ timeout: 2000 });
    f.setMode('fallback'); f.complete('t2');
    await until(() => f.fallbackResponses > 0, 'new-completion fallback response');
    await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await f.page.waitForTimeout(350);
    assert.equal(await f.page.getByText(savedReply, { exact: true }).count(), 1);
    assert.equal(f.reads.some(read => read.completed === 't2'), false,
      'Showing retained t1 cannot acknowledge t2 merely because the latest terminal fallback carries t2');
    assert.equal(f.manager.sync.snapshot().read['answer-fixture'].completed, 't1');
    const next = '合成 t2 最新回答：只有这条真正显示以后才能标记已读。';
    f.setReply(next); f.setMode('structured'); await f.refresh();
    await f.page.getByText(next, { exact: true }).waitFor({ timeout: 2000 });
    await until(() => f.manager.sync.snapshot().read['answer-fixture'].completed === 't2', 'rendered t2 read acknowledgement');
    assert.equal(f.reads.filter(read => read.completed === 't2').length, 1);
  } finally { await f.close(); }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const failures = [];
  try {
    for (const [name, run] of [['readable-cache', readableCache], ['successful-fallback', successfulFallback],
      ['actual-http-failure', actualFailure], ['message-phase', messagePhase], ['retained-read-guard', retainedReadGuard]]) {
      if (process.env.HUB_ANSWER_CASE && process.env.HUB_ANSWER_CASE !== name) continue;
      try { await run(browser); console.log(`PASS answer presentation ${name}: no terminal input`); }
      catch (error) { failures.push(name); console.error(`FAIL answer presentation ${name}: ${error.message}`); }
    }
    assert.deepEqual(failures, [], 'Readable content, source readiness and real failures must have distinct presentation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
