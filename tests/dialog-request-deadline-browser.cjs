// Actual dialog components with synthetic HTTP endpoints. The shim deliberately
// ignores cancellation, reproducing a suspended WebView transport/body reader.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const createdAt = '2026-10-25T00:00:00Z';
const questionDraft = '合成追问草稿：超时后保留，不要自动重复提交。';
const mainDraft = '合成主输入草稿保持不变';

async function fixture(browser, scenario) {
  const question = { id: 'deadline-question', isBlocking: true, submitting: false,
    questions: [{ id: 'detail', question: '合成追问：需要保留哪些内容？', options: [] }] };
  const session = { name: 'dialog-reader', displayName: '对话框超时合成验证', createdAt, shell: 'codex', status: 'running',
    activity: { available: true, detected: true, busy: true, phase: 'waiting', completed: null, contentRevision: 'dialog-content-v1' } };
  const manager = new EventEmitter(); manager.list = () => [session];
  let questionGets = 0, usageGets = 0, inputs = 0, unexpectedWrites = 0;
  const submissions = [];
  const app = express(); app.use(express.json());
  app.get('/api/sessions', (_req, res) => res.json({ sessions: [session] }));
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/mobile', (req, res) => res.json({ ...(req.query.view === 'full'
    ? { text: 'SYNTHETIC_DIALOG_TERMINAL' }
    : { messages: [{ id: 'dialog-answer', role: 'assistant', phase: 'final_answer', text: '合成正文：这些测试不向终端发送信息。' }] }),
    completed: null, contentRevision: 'dialog-content-v1' }));
  app.get('/api/sessions/:name/questions', (_req, res) => {
    questionGets++;
    res.json({ supported: true, requests: scenario === 'usage-body' ? [] : [question] });
  });
  app.get('/api/sessions/codex-usage', (_req, res) => {
    usageGets++;
    res.json({ available: true, stale: false, fetchedAt: new Date().toISOString(), message: '',
      windows: [{ id: 'primary', name: 'Codex', period: '合成额度', remainingPercent: 72, resetsAt: null }] });
  });
  app.post('/api/sessions/:name/questions/:id/respond', (req, res) => {
    submissions.push({ name: req.params.name, id: req.params.id, body: req.body });
    if (scenario === 'respond-headers') return; // Ignore cancellation with no response headers.
    if (scenario === 'respond-body') { res.type('json').write('{'); return; }
    res.json({ ok: true });
  });
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.sendStatus(405); });
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) { unexpectedWrites++; return res.sendStatus(405); }
    next();
  });
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager); await once(server, 'listening');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ scenario, createdAt }) => {
    localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'dialog-reader', createdAt }));
    document.hasFocus = () => false;
    const schedule = window.setTimeout.bind(window);
    // Only request deadlines change. The ordinary 1.5-second question poll,
    // body refresh, lifecycle checks and all other timers retain their timing.
    window.setTimeout = (callback, duration, ...args) => schedule(callback,
      duration === 15000 || duration === 45000 ? 350 : duration, ...args);
    const network = window.fetch.bind(window);
    window.__dialogProbe = { questionAttempts: 0, usageAttempts: 0, aborted: 0 };
    window.fetch = async (input, options = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const probe = window.__dialogProbe;
      if (/\/questions$/.test(url)) {
        probe.questionAttempts++;
        if (scenario === 'question-headers' && probe.questionAttempts === 1) {
          options.signal.addEventListener('abort', () => { probe.aborted++; }, { once: true });
          return new Promise(() => {}); // The transport never acknowledges abort.
        }
      }
      if (/\/codex-usage(?:\?|$)/.test(url)) {
        probe.usageAttempts++;
        if (scenario === 'usage-body' && probe.usageAttempts === 1) {
          const response = await network(input, options);
          options.signal.addEventListener('abort', () => { probe.aborted++; }, { once: true });
          return { ok: response.ok, status: response.status, json: () => new Promise(() => {}) };
        }
      }
      if (/\/questions\/[^/]+\/respond$/.test(url) && scenario.startsWith('respond-')) {
        options.signal.addEventListener('abort', () => { probe.aborted++; }, { once: true });
        // The synthetic server really receives one submission. Removing the
        // signal models the transport continuing after application cancellation.
        return network(input, { ...options, signal: undefined });
      }
      return network(input, options);
    };
  }, { scenario, createdAt });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('合成正文：这些测试不向终端发送信息。', { exact: true }).waitFor({ timeout: 2500 });
  return { page, submissions, get questionGets() { return questionGets; }, get usageGets() { return usageGets; },
    async close() {
      assert.equal(inputs, 0, 'Dialog recovery cannot submit terminal input');
      assert.equal(unexpectedWrites, 0);
      assert.deepEqual(errors, []);
      await context.close(); wss.clients.forEach(socket => socket.terminate()); wss.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    } };
}

async function questionsRecover(browser) {
  const f = await fixture(browser, 'question-headers');
  try {
    // No focus, click, key or input may rescue the initial poll.
    await f.page.getByRole('button', { name: '回答追问', exact: true }).waitFor({ timeout: 3500 });
    const probe = await f.page.evaluate(() => window.__dialogProbe);
    assert(probe.aborted >= 1);
    assert(probe.questionAttempts >= 2);
    assert(f.questionGets >= 1);
    assert.equal(f.submissions.length, 0);
  } finally { await f.close(); }
}

async function usageRecovers(browser) {
  const f = await fixture(browser, 'usage-body');
  try {
    await f.page.getByRole('button', { name: '会话列表', exact: true }).tap();
    await f.page.getByRole('button', { name: '账号额度', exact: true }).tap();
    const dialog = f.page.getByRole('dialog', { name: '账号剩余额度' });
    await dialog.getByText('读取超时，请稍后刷新', { exact: true }).waitFor({ timeout: 1500 });
    const refresh = dialog.getByRole('button', { name: '刷新额度', exact: true });
    assert.equal(await refresh.isDisabled(), false, 'An unresponsive JSON reader cannot keep quota refresh locked');
    assert.equal(f.usageGets, 1);
    await refresh.tap();
    await dialog.locator('progress[value="72"]').waitFor({ timeout: 1500 });
    assert.equal(f.usageGets, 2);
    assert.equal(await dialog.getByText('读取超时，请稍后刷新', { exact: true }).count(), 0);
    assert.equal(f.submissions.length, 0);
  } finally { await f.close(); }
}

async function uncertainSubmission(browser, stage) {
  const f = await fixture(browser, `respond-${stage}`);
  try {
    await f.page.getByRole('button', { name: '回答追问', exact: true }).waitFor({ timeout: 2000 });
    await f.page.getByLabel('消息输入').fill(mainDraft);
    await f.page.getByRole('button', { name: '回答追问', exact: true }).tap();
    const dialog = f.page.getByRole('dialog', { name: '回答 Codex 追问' });
    await dialog.getByLabel('你的回答', { exact: true }).fill(questionDraft);
    await dialog.getByRole('button', { name: '提交回答', exact: true }).tap();
    await dialog.getByText('回答结果未确认，请查看全文后再操作', { exact: true }).waitFor({ timeout: 1500 });
    assert.equal(await dialog.getByLabel('你的回答', { exact: true }).inputValue(), questionDraft);
    assert.equal(await dialog.getByRole('button', { name: '提交回答', exact: true }).isDisabled(), false);
    await f.page.waitForTimeout(1800); // Cross another normal poll without retrying the write.
    assert.deepEqual(f.submissions, [{ name: 'dialog-reader', id: 'deadline-question', body: { action: 'answer', answers: { detail: questionDraft } } }]);
    assert.equal(await f.page.getByLabel('消息输入').inputValue(), mainDraft);
    await dialog.getByRole('button', { name: '收起追问，保留草稿', exact: true }).tap();
    await f.page.getByRole('button', { name: '回答追问', exact: true }).tap();
    assert.equal(await dialog.getByLabel('你的回答', { exact: true }).inputValue(), questionDraft);
    assert.equal(f.submissions.length, 1);
  } finally { await f.close(); }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] }), failures = [];
  try {
    for (const [name, run] of [['question-poll-headers', () => questionsRecover(browser)], ['usage-json-body', () => usageRecovers(browser)],
      ['respond-headers', () => uncertainSubmission(browser, 'headers')], ['respond-json-body', () => uncertainSubmission(browser, 'body')]]) {
      if (process.env.HUB_DIALOG_CASE && process.env.HUB_DIALOG_CASE !== name) continue;
      try { await run(); console.log(`PASS dialog deadline ${name}: no terminal input, no automatic resubmission`); }
      catch (error) { failures.push(name); console.error(`FAIL dialog deadline ${name}: ${error.message}`); }
    }
    assert.deepEqual(failures, [], 'Dialog requests must finish their application deadline even when the transport ignores abort');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
