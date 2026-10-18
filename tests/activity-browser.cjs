// Actual Vue UI, synthetic transcripts only. No access to live user sessions.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const contentResponse = require('../server/services/content-response');
const app = express(); app.use(express.json());
const manager = new EventEmitter();
const make = (name, displayName, phase) => ({ name, displayName, shell: 'codex', status: 'running', createdAt: '2026-10-14T00:00:00Z', activity: { available: true, phase, busy: ['thinking','executing','responding','waiting'].includes(phase), completed: phase === 'completed' ? name + '-done' : null, startedAt: new Date(Date.now() - 75000).toISOString() } });
const sessions = [make('reader', '移动端适配与交互优化', 'executing'), make('done', '整理项目说明', 'completed'), make('wait', '确认下一步发布方案', 'waiting')];
const transcript = [
  { id: 'm1', role: 'user', text: '帮我检查手机界面，状态要清楚，操作要方便。' },
  { id: 'm2', role: 'assistant', phase: 'commentary', text: '正在检查小屏幕布局和状态切换，输入草稿会保留。' },
  { id: 'm3', role: 'assistant', phase: 'final_answer', text: '已完成这轮检查：\n\n- 会话列表显示明确的工作状态。\n- 等待确认时，可以直接打开全文。\n- 手机与电脑使用相同的状态规则。\n\n```js\nconsole.log("Ready to continue");\n```' },
];
let failing = false, version = 0;
app.get('/api/sessions', (_req, res) => failing ? res.status(503).json({ error: 'fixture offline' }) : res.json({ sessions }));
app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'codex', name: 'Codex' }] }));
app.get('/api/sessions/:name/mobile', (req, res) => contentResponse(req, res, { ...(req.query.view === 'full'
  ? { text: 'Would you like to run the following command?\n\n  $ npm run build\n\n› 1. Yes, proceed\n  2. No, and tell Codex what to do differently\n\n  Press enter to confirm · esc to cancel', version }
  : { messages: transcript, version }), completed: sessions.find(s => s.name === req.params.name)?.activity.completed || null }));
app.use(express.static(path.join(__dirname, '../server/public')));
(async () => {
  const server = app.listen(0, '127.0.0.1'); const wss = setupWebSocket(server, manager); await once(server, 'listening');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const output = path.join(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
  try {
    for (const width of [320, 412]) {
      sessions.length = 3;
      sessions[0].activity = make('reader', '', 'executing').activity;
      const context = await browser.newContext({ viewport: { width, height: 915 }, isMobile: true, hasTouch: true });
      await context.addInitScript(() => localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt: '2026-10-14T00:00:00Z' })));
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.locator('.mobile-session-header .activity-badge.busy').waitFor();
      assert.equal(await page.locator('.working-badge').count(), 0, 'Only the selected session is working, so the count is hidden');
      assert.equal(await page.locator('.unread-badge').textContent(), '1');
      sessions.push(make('worker', '后台检查项目文档', 'responding'));
      manager.emit('session:activity', sessions[3]);
      await page.waitForFunction(() => document.querySelector('.working-badge')?.textContent === '1');
      assert.match(await page.locator('.working-shortcut').getAttribute('aria-label'), /不含当前会话/);
      async function compactTitle() {
        const title = await page.locator('.mobile-session-title').boundingBox();
        const badge = await page.locator('.mobile-session-header .activity-badge').boundingBox();
        const header = await page.locator('.mobile-session-header').boundingBox();
        assert(badge.x >= title.x + title.width && Math.abs(badge.y + badge.height / 2 - title.y - title.height / 2) < 1, 'Status follows title on the same line');
        assert(header.height < 48, `Title header stays compact: ${header.height}px`);
      }
      await compactTitle();
      await page.getByLabel('消息输入').fill('保留这条尚未发送的中文草稿');
      async function transition(phase, overrides = {}) {
        sessions[0].activity = { ...make('reader', '', phase).activity, ...overrides }; version++;
        manager.emit('session:activity', sessions[0]);
      }
      await transition('waiting');
      await page.locator('.status-guidance.waiting').waitFor();
      assert.equal(await page.locator('.working-badge').textContent(), '1', 'Changes to the selected session do not affect the count of other workers');
      if (width === 412) await page.screenshot({ path: path.join(output, 'status-waiting-412.png') });
      await page.getByRole('button', { name: '查看全文' }).tap();
      await page.locator('.mobile-navigation').waitFor();
      assert.equal(await page.getByLabel('消息输入').inputValue(), '保留这条尚未发送的中文草稿');
      await page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      await page.getByRole('button', { name: '方向键与回车', exact: true }).tap();
      await transition('error'); await page.locator('.status-guidance.error').waitFor();
      assert.equal(await page.locator('.mobile-session-header .unread').count(), 0);
      await transition('interrupted'); await page.locator('.status-guidance.interrupted').waitFor();
      await transition('completed');
      await page.waitForFunction(() => document.querySelector('.mobile-session-header .activity-badge')?.textContent.includes('已完成'));
      await compactTitle();
      await page.screenshot({ path: path.join(output, `status-completed-${width}.png`) });
      const readingBeforeUnknown = await page.locator('.mobile-reading').boundingBox();
      // Status and content can update independently. Neither a missing phase nor
      // unavailable tracking should push working content down or imply completion.
      for (const activity of [{}, { available: false, phase: undefined, completed: 'stale-completion' }]) {
        await transition('unknown', activity);
        await page.locator('.mobile-session-header .activity-badge.unknown').waitFor();
        assert.equal(await page.locator('.status-guidance').count(), 0, 'Unknown status adds no guidance row');
        await compactTitle();
        const reading = await page.locator('.mobile-reading').boundingBox();
        assert.equal(reading.y, readingBeforeUnknown.y, 'Unavailable status does not push content down');
        assert.equal(reading.height, readingBeforeUnknown.height, 'Unavailable status preserves reading space');
        assert.equal(await page.getByLabel('消息输入').inputValue(), '保留这条尚未发送的中文草稿');
      }
      const originalProgress = transcript[1];
      transcript[1] = { ...originalProgress, text: '状态同步期间，新的工作进展仍能正常显示。' }; version++;
      await page.getByText(transcript[1].text, { exact: true }).waitFor();
      assert.equal(await page.locator('.mobile-session-header .unread, .mobile-session-header .busy').count(), 0, 'Visible replies never imply a reliable task outcome');
      await page.screenshot({ path: path.join(output, `status-unknown-${width}.png`) });
      await page.getByRole('button', { name: '显示执行过程', exact: true }).tap();
      await page.locator('.mobile-output').waitFor();
      await compactTitle();
      assert.equal(await page.locator('.status-guidance').count(), 0, 'Full view also stays compact');
      assert.equal(await page.getByLabel('消息输入').inputValue(), '保留这条尚未发送的中文草稿');
      await page.getByRole('button', { name: '隐藏执行过程', exact: true }).tap();
      transcript[1] = originalProgress; version++;
      await transition('thinking'); await page.locator('.mobile-session-header .activity-badge.busy').waitFor();
      failing = true; manager.emit('session:activity', sessions[0]);
      await page.locator('.mobile-session-header').getByText('连接中断', { exact: true }).waitFor();
      await compactTitle();
      assert.equal(await page.locator('.status-guidance').count(), 0, 'Connection status also uses only the title row');
      await page.locator('.working-badge').waitFor({ state: 'detached' });
      assert.equal(await page.getByLabel('消息输入').inputValue(), '保留这条尚未发送的中文草稿');
      failing = false; manager.emit('session:activity', sessions[0]);
      await page.locator('.mobile-session-header .activity-badge.busy').waitFor();
      assert.equal(await page.locator('.working-badge').textContent(), '1');
      await page.screenshot({ path: path.join(output, `status-mobile-${width}.png`) });
      const overflow = await page.evaluate(() => ({ root: document.documentElement.scrollWidth, width: innerWidth, toolbar: document.querySelector('.toolbar').scrollWidth }));
      assert(overflow.root <= width && overflow.toolbar <= width, JSON.stringify(overflow));
      await page.getByRole('button', { name: '会话列表', exact: true }).tap();
      await page.locator('[data-session-id="wait"] .activity-badge.waiting').waitFor();
      await page.locator('[data-session-id="done"] .activity-badge.unread').waitFor();
      await page.locator('.sidebar').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
      await page.screenshot({ path: path.join(output, `status-list-${width}.png`) });
      await page.locator('[data-session-id="done"]').tap();
      await page.waitForFunction(() => document.querySelector('.mobile-session-title')?.textContent === '整理项目说明');
      await page.locator('.unread-shortcut').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.working-badge').textContent(), '2', 'Leaving a worker for a completed session counts both background workers');
      await page.getByRole('button', { name: '会话列表', exact: true }).tap();
      await page.locator('[data-session-id="reader"]').tap();
      await page.waitForFunction(() => document.querySelector('.mobile-session-title')?.textContent === '移动端适配与交互优化');
      assert.equal(await page.locator('.working-badge').textContent(), '1', 'Returning to a worker excludes it immediately');
      assert.equal(await page.getByLabel('消息输入').inputValue(), '保留这条尚未发送的中文草稿');
      const workingShortcut = page.getByRole('button', { name: /查看下一个工作中的会话/ });
      for (const name of ['后台检查项目文档', '移动端适配与交互优化']) {
        await workingShortcut.tap();
        await page.waitForFunction(name => document.querySelector('.mobile-session-title')?.textContent === name, name);
        assert.equal(await page.locator('.working-badge').textContent(), '1');
      }
      sessions.push(make('third', '检查第三个工作会话', 'executing'));
      manager.emit('session:activity', sessions[4]);
      await page.waitForFunction(() => document.querySelector('.working-badge')?.textContent === '2');
      for (const name of ['后台检查项目文档', '检查第三个工作会话', '移动端适配与交互优化', '后台检查项目文档', '检查第三个工作会话', '移动端适配与交互优化']) {
        await workingShortcut.tap();
        await page.waitForFunction(name => document.querySelector('.mobile-session-title')?.textContent === name, name);
        assert.equal(await page.locator('.working-badge').textContent(), '2');
      }
      assert.equal(await page.getByLabel('消息输入').inputValue(), '保留这条尚未发送的中文草稿', 'Cycling restores the original session draft');
      await page.setViewportSize({ width, height: 430 });
      await page.getByLabel('消息输入').focus();
      const composer = await page.locator('.composer').boundingBox();
      assert(composer.y >= 0 && composer.y + composer.height <= 431, 'Composer stays visible above simulated keyboard');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: compact unknown/offline status, live content and drafts preserved, full view, worker cycling, states, recovery, keyboard layout`);
    }
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, hasTouch: true, isMobile: true });
    transcript[2] = { ...transcript[2], phase: 'commentary', text: '目前已确认：\n\n- 会话列表显示明确的工作状态。\n- 等待确认时，可以直接打开全文。\n- 手机与电脑使用相同的状态规则。\n\n接下来继续检查输入与网络恢复。\n\n```js\nconsole.log("Checking interactions…");\n```' };
    await context.addInitScript(() => localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt: '2026-10-14T00:00:00Z' })));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.message.assistant').first().waitFor();
    await page.getByRole('button', { name: '会话列表', exact: true }).tap();
    await page.locator('[data-session-id="wait"] .activity-badge.waiting').waitFor();
    await page.locator('.sidebar').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: path.join(output, 'ttyd-status-preview.png') });
    await context.close();
  } finally { await browser.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
