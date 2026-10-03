// Browser input/receipt checks with synthetic Codex question results only.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { once, EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const { applyEvent } = require('../server/services/codex-activity');
const contentResponse = require('../server/services/content-response');
const app = express(); app.use(express.json());
const session = { name: 'input-fixture', displayName: '手机输入验证', createdAt: '2026-10-03T00:00:00Z', shell: 'codex', status: 'running', activity: { available: true, busy: true } };
let state, writes, confirm, kind, sequence;
function reset() { state = { messages: [{ id: 'initial', role: 'user', text: '请选择一个选项，并补充说明。' }], sequence: 0 }; writes = []; confirm = false; kind = 'question'; sequence = 0; }
app.get('/api/sessions', (_req, res) => res.json({ sessions: [session] }));
app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
app.get('/api/sessions/:name/mobile', (req, res) => contentResponse(req, res, req.query.view === 'full'
  ? { text: '请选择一个选项，并补充说明。\n终端预览', activity: session.activity }
  : { messages: state.messages, inputReceipts: state.inputReceipts || [], activity: session.activity }));
app.post('/api/sessions/:name/input', async (req, res) => {
  writes.push(req.body);
  if (req.body.text && req.body.key === 'Enter' && confirm) {
    if (kind === 'question') {
      const id = 'call-' + sequence++;
      applyEvent(state, { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: id } });
      applyEvent(state, { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ answers: { choice: { answers: ['Option A', 'user_note: ' + req.body.text] } } }) } });
    } else state.messages.push({ id: 'message-' + sequence++, role: 'user', text: req.body.text });
  }
  await new Promise(r => setTimeout(r, 100));
  res.json({ ok: true });
});
app.use(express.static(path.join(__dirname, '../server/public')));
(async () => {
  const server = app.listen(0, '127.0.0.1'); const wss = setupWebSocket(server, new EventEmitter()); await once(server, 'listening');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const output = path.join(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
  try {
    for (const full of [false, true]) {
      reset();
      const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
      await context.addInitScript(({ session, full }) => {
        localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: session.name, createdAt: session.createdAt }));
        localStorage.setItem('web-ttyd-hub.mobile-reading.v1', JSON.stringify({ showExecution: full }));
      }, { session, full });
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const input = page.getByLabel('消息输入'); await input.waitFor();
      await page.getByRole('button', { name: '方向键与回车', exact: true }).tap();
      await page.getByRole('button', { name: 'Shift 加左方向键', exact: true }).tap();
      await page.waitForFunction(() => !document.querySelector('.send').disabled);
      assert.deepEqual(writes[0], { text: '', key: 'S-Left' });
      // The absence of a receipt must keep the pending message, even after HTTP 200.
      await input.fill('等待真正接收'); await page.locator('.send').tap();
      await page.locator('.pending-message.delivered').waitFor();
      assert.equal(await page.locator('.pending-message').count(), 1);
      assert.equal(await page.getByText(/下一次工具调用后/).count(), 0);
      await page.getByRole('button', { name: '关闭发送提示', exact: true }).tap();
      confirm = true;
      // A real question result contains user_note, with no matching user chat message.
      await input.fill('这是我的追问\n第二行'); await page.locator('.send').tap();
      await page.waitForFunction(() => !document.querySelector('.send').disabled);
      await page.waitForSelector('.pending-message', { state: 'detached' });
      assert.equal(state.messages.length, 1);
      assert.equal(writes.filter(x => x.text === '这是我的追问\n第二行').length, 1);
      // IME can expose visible characters before Vue's v-model commits them.
      kind = 'normal';
      await input.evaluate(el => {
        el.focus(); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = '输入法尚未结束的中文'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: el.value }));
      });
      await page.locator('.send').tap();
      await page.waitForFunction(() => !document.querySelector('.send').disabled);
      await page.waitForSelector('.pending-message', { state: 'detached' });
      assert.equal(writes.at(-1).text, '输入法尚未结束的中文');
      assert.equal(writes.at(-1).key, 'Enter');
      await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      assert.equal(await input.inputValue(), '');
      await page.screenshot({ path: path.join(output, `mobile-input-${full ? 'full' : 'answer'}.png`) });
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${full ? 'full' : 'answer'}: question receipt clears, unconfirmed send remains, IME visible text, exactly one submission`);
    }
  } finally { await browser.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
