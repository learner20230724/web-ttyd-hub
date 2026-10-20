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
let state, writes, confirm, kind, sequence, failInput, holdInput, terminalText;
function reset() { state = { messages: [{ id: 'initial', role: 'user', text: '请选择一个选项，并补充说明。' }], sequence: 0 }; writes = []; confirm = false; kind = 'question'; sequence = 0; failInput = false; holdInput = false; terminalText = '请选择一个选项，并补充说明。\n终端预览'; }
app.get('/api/sessions', (_req, res) => res.json({ sessions: [session] }));
app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
app.get('/api/sessions/:name/mobile', (req, res) => contentResponse(req, res, req.query.view === 'full'
  ? { text: terminalText, activity: session.activity }
  : { messages: state.messages, inputReceipts: state.inputReceipts || [], activity: session.activity }));
app.post('/api/sessions/:name/input', async (req, res) => {
  writes.push(req.body);
  if (holdInput) {
    if (holdInput === 'body') res.type('json').write('{');
    return;
  }
  if (failInput) { failInput = false; res.status(503).json({ error: 'synthetic disconnected terminal' }); return; }
  if (req.body.text === '/model') terminalText = '选择模型（合成验证）\n\n› 1. 示例模型甲\n  2. 示例模型乙\n\n↑↓ 选择 · 回车确认 · ESC 返回';
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
  const auditOutput = path.join(output, 'ux-audit'); fs.mkdirSync(auditOutput, { recursive: true });
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
      // Local commands never enter the transcript. Delivery must not leave a
      // permanent model-receipt card, and menus need the terminal controls.
      confirm = false;
      for (const command of ['/status', '/model', '/new', '/resume', '/review']) {
        if (await page.getByRole('button', { name: '隐藏执行过程', exact: true }).count()) await page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
        await input.fill(command); await page.locator('.send').tap();
        await page.waitForFunction(() => !document.querySelector('.send').disabled);
        assert.deepEqual(writes.at(-1), { text: command, key: 'Enter' });
        assert.equal(await page.locator('.pending-message').count(), 0, command + ' is not a model message');
        await page.getByRole('button', { name: '隐藏执行过程', exact: true }).waitFor();
        assert(await page.getByRole('button', { name: '终端回车', exact: true }).isVisible());
        await page.getByText('已发送到终端', { exact: true }).waitFor();
        if (command === '/model' && !full) {
          await page.getByText(/选择模型（合成验证）/).waitFor();
          await page.screenshot({ path: path.join(auditOutput, '05-command-navigation.png') });
        }
      }
      for (const [label, key] of [['方向键下', 'Down'], ['方向键上', 'Up'], ['终端回车', 'Enter'], ['终端 ESC', 'Escape']]) {
        await page.getByRole('button', { name: label, exact: true }).tap();
        await page.waitForFunction(() => !document.querySelector('.send').disabled);
        assert.deepEqual(writes.at(-1), { text: '', key });
        assert.equal(await page.locator('.pending-message').count(), 0);
      }
      // Paste-only opens the slash palette without silently sending Enter.
      await page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await page.getByRole('button', { name: '终端按键', exact: true }).tap();
      await input.fill('/'); await page.getByRole('button', { name: '仅输入', exact: true }).tap();
      await page.waitForFunction(() => !document.querySelector('.send').disabled);
      assert.deepEqual(writes.at(-1), { text: '/', key: null });
      await page.getByText('已输入终端，尚未按回车', { exact: true }).waitFor();
      await page.getByRole('button', { name: '隐藏执行过程', exact: true }).waitFor();
      assert.equal(await page.locator('.pending-message').count(), 0);
      // A terminal command failure must keep the draft and report uncertainty.
      failInput = true; await input.fill('/status'); await page.locator('.send').tap();
      await page.waitForFunction(() => !document.querySelector('.send').disabled);
      assert.equal(await input.inputValue(), '/status');
      await page.getByRole('alert').filter({ hasText: '未确认发送成功' }).waitFor();
      assert.equal(await page.locator('.pending-message').count(), 0);
      await page.locator('.send').tap(); await page.waitForFunction(() => !document.querySelector('.send').disabled);
      assert.equal(await input.inputValue(), '');
      // A path is a normal prompt, not mistaken for a slash command.
      await page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await input.fill('/tmp/project/file.md'); await page.locator('.send').tap();
      await page.locator('.pending-message.delivered').waitFor();
      assert.equal(await page.getByRole('button', { name: '显示执行过程', exact: true }).count(), 1);
      await page.getByRole('button', { name: '关闭发送提示', exact: true }).tap();
      // A lost confirmation must unlock input without repeating the POST. Test
      // both a response held before headers and a response stalled mid-body.
      const previousWrites = writes.length;
      holdInput = full ? 'body' : 'headers';
      const timeoutText = '未收到发送确认的演示消息';
      await input.fill(timeoutText); await page.locator('.send').tap();
      await page.locator('.pending-message.sending').waitFor();
      await page.waitForFunction(() => !document.querySelector('.send').disabled, null, { timeout: 12000 });
      await page.locator('.pending-message.uncertain').waitFor();
      assert.equal(await input.inputValue(), timeoutText, 'Unconfirmed input must remain available');
      assert.equal(writes.length, previousWrites + 1, 'A confirmation timeout never resends input');
      assert(await page.getByRole('button', { name: '终端回车', exact: true }).isEnabled());
      await page.getByRole('alert').filter({ hasText: '发送确认超时' }).waitFor();
      await page.waitForTimeout(1500);
      assert.equal(writes.length, previousWrites + 1, 'Background reading does not retry uncertain input');
      await page.getByRole('alert').filter({ hasText: '发送确认超时' }).waitFor();
      if (!full) await page.screenshot({ path: path.join(auditOutput, '06-input-timeout.png') });
      holdInput = false;
      await page.getByRole('button', { name: '关闭发送提示', exact: true }).tap();
      await page.screenshot({ path: path.join(output, `mobile-input-${full ? 'full' : 'answer'}.png`) });
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${full ? 'full' : 'answer'}: question receipts, unconfirmed prompts, IME, slash delivery/navigation, paste-only, retry, paths, ${full ? 'mid-body' : 'pre-headers'} confirmation timeout with no resend`);
    }
    for (const shell of ['bash', 'codex']) {
      reset(); session.shell = shell; session.activity = { available: false, detected: false, busy: false };
      const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
      await context.addInitScript(session => localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: session.name, createdAt: session.createdAt })), session);
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByLabel('消息输入').fill(shell === 'bash' ? 'echo terminal-command' : '任务状态尚未就绪时的普通消息');
      await page.locator('.send').tap(); await page.waitForFunction(() => !document.querySelector('.send').disabled);
      if (shell === 'bash') {
        assert.equal(await page.locator('.pending-message').count(), 0, 'Shell commands have no Codex transcript receipt');
        await page.getByText('已发送到终端', { exact: true }).waitFor();
      } else {
        await page.locator('.pending-message.delivered').waitFor();
        assert.match(await page.locator('.pending-status').innerText(), /等待 Codex 确认接收/, 'Missing task telemetry does not change a Codex prompt into a shell command');
      }
      await context.close();
      console.log(`PASS ${shell}: input semantics do not depend on task-status availability`);
    }
  } finally { await browser.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
