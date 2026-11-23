// Phone UI using synthetic questions/quota only. Never screenshot real account data.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const app = express(); app.use(express.json());
const manager = new EventEmitter();
const sessions = ['reader', 'other'].map((name, i) => ({ name, displayName: i ? '另一个工作项目' : '手机追问与账号额度', shell: 'codex', status: 'running', createdAt: '2026-10-14T00:00:00Z', activity: { available: true, detected: true, phase: i ? 'executing' : 'waiting', busy: true, completed: null } }));
const makeQuestion = (id = 'one') => ({ id, isBlocking: true, questions: [{ id: 'plan', question: '手机首页采用哪一种布局？', options: [{ label: '简洁列表（推荐）', description: '保留主要信息，手机阅读更方便。' }, { label: '详细卡片', description: '显示更多项目详情。' }] }, { id: 'extra', question: '还有什么需要保留？', options: [] }] });
let requests = [], posts = [], offline = false, delayPost = false, stale = false, unavailable = false;
app.get('/api/sessions', (_req, res) => res.json({ sessions }));
app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
app.get('/api/sessions/codex-usage', (_req, res) => {
  const resetsAt = new Date(Date.now() + 4 * 86400000).toISOString();
  const windows = [
    { id: 'other:primary', name: 'Other', period: '每周额度', remainingPercent: 95, resetsAt },
    { id: 'codex:primary', name: 'Codex', period: '5 小时额度', remainingPercent: 82, resetsAt },
  ];
  if (!unavailable) windows.push({ id: 'codex:secondary', name: 'Codex', period: '每周额度', remainingPercent: 61, resetsAt });
  res.json({ available: true, stale, fetchedAt: new Date().toISOString(), windows });
});
app.get('/api/sessions/:name/mobile', (req, res) => res.json(req.query.view === 'full' ? { text: 'Synthetic Codex terminal' } : { messages: [{ id: 'hello', role: 'assistant', text: '正在调整手机界面。请确认下面的问题，或直接跳过，让任务继续。' }] }));
app.get('/api/sessions/:name/questions', (req, res) => offline ? res.status(503).json({ error: 'offline' }) : res.json({ supported: true, requests: req.params.name === 'reader' ? requests : [] }));
app.post('/api/sessions/:name/questions/:id/respond', async (req, res) => {
  posts.push({ name: req.params.name, id: req.params.id, ...req.body });
  if (delayPost) await new Promise(resolve => setTimeout(resolve, 350));
  requests = requests.filter(q => q.id !== req.params.id); res.json({ ok: true });
});
app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
async function desktopQuota(browser, url, output) {
  const page = await browser.newPage({ viewport: { width: 1040, height: 585 } });
  try {
    const quota = page.getByRole('button', { name: '账号额度', exact: true });
    let pending;
    await page.route('**/api/sessions/codex-usage*', route => { pending = route; });
    await page.goto(url);
    await quota.waitFor();
    assert.equal(pending, undefined);
    const anchor = await quota.boundingBox();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await quota.click();
    const card = page.locator('.usage-card');
    await card.getByText('正在查询额度…').waitFor();
    await page.clock.fastForward(12000);
    await pending.fulfill({ json: { available: true, fetchedAt: '2026-10-14T01:20:00Z',
      windows: [{ id: 'codex:primary', name: 'Codex', period: '每周额度', remainingPercent: 0, resetsAt: null }] } });
    await card.getByText('0%', { exact: true }).waitFor();
    await card.getByText('暂未提供', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    // The lookup took 12s. The full minute belongs to the displayed result.
    await page.clock.fastForward(59999);
    assert.equal(await quota.getAttribute('aria-expanded'), 'true');
    assert(Math.abs((await quota.boundingBox()).y - anchor.y) < 1, 'Opening upwards keeps the button in place');
    await page.clock.fastForward(1);
    assert.equal(await quota.getAttribute('aria-expanded'), 'false');
    await page.clock.resume();
    await page.unroute('**/api/sessions/codex-usage*');
    await quota.click();
    await card.getByText('61%', { exact: true }).waitFor();
    await page.locator('[data-session-id="reader"]').click();
    await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('会话草稿');
    assert.equal(await quota.getAttribute('aria-expanded'), 'true', 'The open card leaves the conversation interactive');
    await page.screenshot({ path: path.join(output, 'codex-usage-desktop.png'), animations: 'disabled' });
    await quota.press('Escape');
    assert.equal(await quota.getAttribute('aria-expanded'), 'false');
  } finally { await page.close(); }
}

(async () => {
  const server = app.listen(0, '127.0.0.1'); const wss = setupWebSocket(server, manager); await once(server, 'listening');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const output = path.join(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
  try {
    await desktopQuota(browser, `http://127.0.0.1:${server.address().port}`, output);
    for (const width of [320, 412]) {
      requests = [makeQuestion()]; posts = []; offline = false; stale = false; unavailable = false;
      const context = await browser.newContext({ viewport: { width, height: 915 }, isMobile: true, hasTouch: true });
      await context.addInitScript(() => localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt: '2026-10-14T00:00:00Z' })));
      const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('button', { name: '回答追问', exact: true }).waitFor();
      await page.getByLabel('消息输入').fill('尚未发送的主输入草稿');
      await page.getByRole('button', { name: '回答追问', exact: true }).tap();
      await page.getByRole('dialog').waitFor();
      assert(await page.getByRole('button', { name: '提交回答', exact: true }).isDisabled(), 'No implicit default answer');
      await page.getByRole('radio', { name: /简洁列表/ }).check();
      await page.getByLabel('自行回答或补充说明').fill('保留绿色完成提醒');
      await page.getByLabel('你的回答', { exact: true }).fill('保留工作会话循环切换\n不要挤占顶部');
      await page.screenshot({ path: path.join(output, `codex-questions-${width}.png`) });
      const overflow = await page.evaluate(() => ({ root: document.documentElement.scrollWidth, width: innerWidth, dialog: document.querySelector('dialog').scrollWidth, dialogWidth: document.querySelector('dialog').clientWidth }));
      assert(overflow.root <= width && overflow.dialog <= overflow.dialogWidth, JSON.stringify(overflow));
      await page.getByRole('button', { name: '收起追问，保留草稿' }).tap();
      await page.getByRole('button', { name: '会话列表', exact: true }).tap(); await page.locator('[data-session-id="other"]').tap();
      await page.getByRole('button', { name: '回答追问', exact: true }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '会话列表', exact: true }).tap(); await page.locator('[data-session-id="reader"]').tap();
      await page.getByRole('button', { name: '回答追问', exact: true }).tap();
      assert.equal(await page.getByLabel('你的回答', { exact: true }).inputValue(), '保留工作会话循环切换\n不要挤占顶部');
      delayPost = true;
      await page.getByRole('button', { name: '提交回答', exact: true }).tap();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(posts.length, 1); assert.equal(posts[0].name, 'reader'); assert.equal(posts[0].action, 'answer');
      assert.equal(posts[0].answers.plan, '简洁列表（推荐）\n补充：保留绿色完成提醒');
      assert.equal(await page.getByLabel('消息输入').inputValue(), '尚未发送的主输入草稿');
      requests = [makeQuestion('second')];
      await page.getByRole('button', { name: '回答追问', exact: true }).waitFor();
      await page.getByRole('button', { name: '跳过追问', exact: true }).tap();
      await page.getByText('已跳过本次追问，任务可继续', { exact: true }).waitFor();
      assert.equal(posts.length, 2); assert.deepEqual(posts[1], { name: 'reader', id: 'second', action: 'skip' });
      requests = [makeQuestion('third')];
      await page.getByRole('button', { name: '回答追问', exact: true }).waitFor();
      offline = true; await page.getByText('追问连接暂不可用，请稍候或查看全文。', { exact: true }).waitFor();
      assert(await page.getByRole('button', { name: '跳过追问', exact: true }).isDisabled());
      offline = false; await page.waitForFunction(() => !document.querySelector('.question-prompt .primary')?.disabled);
      await page.getByRole('button', { name: '回答追问', exact: true }).tap();
      requests = []; await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(posts.length, 2, 'Other-device resolution closes without sending');
      await page.getByRole('button', { name: '会话列表', exact: true }).tap();
      const quota = page.getByRole('button', { name: '账号额度', exact: true });
      await quota.tap();
      const card = page.locator('.usage-card');
      await card.getByText('61%', { exact: true }).waitFor();
      assert.doesNotMatch(await card.innerText(), /82%|95%|5 小时/);
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.getByRole('button', { name: '会话列表', exact: true }).getAttribute('aria-expanded'), 'true');
      await page.screenshot({ path: path.join(output, `codex-usage-${width}.png`), animations: 'disabled' });
      stale = true;
      await quota.tap(); await quota.tap();
      await card.getByText('上次成功更新', { exact: true }).waitFor();
      assert(await card.getByText('61%').isVisible());
      unavailable = true; stale = false;
      await quota.tap(); await quota.tap();
      await card.getByText('暂无 Codex 每周额度数据').waitFor();
      assert.doesNotMatch(await card.innerText(), /%/);
      await quota.tap();
      assert.equal(await quota.getAttribute('aria-expanded'), 'false');
      await page.locator('[data-session-id="reader"]').tap();
      requests = [makeQuestion('keyboard')]; await page.getByRole('button', { name: '回答追问', exact: true }).tap();
      await page.setViewportSize({ width, height: 450 });
      await page.getByLabel('你的回答', { exact: true }).fill('软键盘打开时仍能输入');
      await page.getByRole('button', { name: '跳过本次追问', exact: true }).tap();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []); await context.close();
    }
    console.log('Desktop quota stays anchored and interactive for 60s after the result. 320/412px: inline quota, questions, drafts, switching and keyboard-sized viewport passed.');
  } finally { await browser.close(); for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(err => { console.error(err); process.exitCode = 1; });
