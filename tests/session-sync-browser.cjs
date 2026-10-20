// Independent browser contexts exercise the real Vue store, API and broadcasts.
// All sessions/transcripts are synthetic; no live terminal or model is accessed.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { once } = require('node:events');
const { chromium } = require('playwright');
const Manager = require('../server/services/session-manager');
const routes = require('../server/routes/sessions');
const sockets = require('../server/ws');
const syntheticTerminals = require('./synthetic-terminal.cjs');
const createdAt = '2026-10-14T00:00:00.000Z';
const manager = new Manager(19800, 19801); manager.activity.close(); clearInterval(manager.archiveSweep);
for (const [name, displayName, phase] of [['worker', '正在处理的项目', 'executing'], ['done', '手机已查看的回复', 'completed'], ['second', '电脑已查看的回复', 'completed']]) {
  manager.sessions.set(name, { name, displayName, shell: 'codex', status: 'running', createdAt,
    activity: { available: true, phase, busy: phase === 'executing', completed: phase === 'completed' ? `${name}:1` : null } });
}
const app = express(); app.use(express.json());
app.get('/api/sessions/:name/mobile', (req, res) => res.json({ messages: [{ id: 'example', role: 'assistant', text: '这是一条合成测试回复。手机查看后，电脑上的绿色未读提醒也会消除。', phase: 'final_answer' }], version: 1, completed: manager.sessions.get(req.params.name)?.activity.completed || null }));
app.get('/api/sessions/:name/questions', (_req, res) => res.json({ available: false, questions: [] }));
app.use('/api/sessions', routes(manager)); app.use(express.static(path.join(__dirname, '../server/public')));
const card = (page, name) => page.locator(`.session-list [data-session-id="${name}"]`);
const state = (page, name, value) => card(page, name).locator('.activity-badge.' + value).first().waitFor({ state: 'attached', timeout: 12000 });
async function sidebar(page) {
  const toggle = page.getByRole('button', { name: '会话列表', exact: true });
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}
async function select(page, name) { await page.bringToFront(); await sidebar(page); await card(page, name).click(); }
async function pin(page, name) {
  await sidebar(page); await card(page, name).getByLabel('会话操作菜单').click();
  await page.getByRole('button', { name: '置顶会话', exact: true }).click();
}
function transition(name, phase, completed = null) {
  manager.sessions.get(name).activity = { available: phase !== 'unknown', phase, busy: ['executing', 'thinking', 'responding', 'waiting'].includes(phase), completed };
  manager.emit('session:activity', manager.serialize(manager.sessions.get(name)));
}
(async () => {
  const server = app.listen(0, '127.0.0.1'), wss = sockets(server, manager); await once(server, 'listening');
  const terminals = syntheticTerminals(server, manager);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [], contexts = [];
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    async function client(mobile) {
      const context = await browser.newContext({ viewport: mobile ? { width: 412, height: 915 } : { width: 1200, height: 800 }, isMobile: mobile, hasTouch: mobile });
      contexts.push(context);
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(base); await state(page, 'done', 'unread'); return { context, page };
    }
    const phone = await client(true), desktop = await client(false);
    await select(phone.page, 'worker'); await phone.page.getByLabel('消息输入').fill('手机未发送的草稿');
    // Hold the other device's list transport. Shared reads must still arrive
    // over its socket, including the race while that socket reconnects.
    const heldLists = [];
    const holdList = async route => {
      const response = await route.fetch();
      heldLists.push(() => route.fulfill({ response }).catch(() => {}));
    };
    await desktop.context.route('**/api/sessions', holdList);
    await desktop.page.evaluate(() => window.dispatchEvent(new Event('online')));
    for (let i = 0; !heldLists.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(heldLists.length, 'The old list must be held before reading on the phone');
    await select(phone.page, 'done');
    await card(desktop.page, 'done').locator('.activity-badge.idle').first().waitFor({ state: 'attached', timeout: 1500 });
    await desktop.context.unroute('**/api/sessions', holdList);
    await Promise.all(heldLists.map(release => release()));
    assert.match(await card(desktop.page, 'done').textContent(), /已完成 · 已读/);
    assert.equal(await desktop.page.locator('.session-card.active').count(), 0, 'Remote reads never switch selection');
    await select(desktop.page, 'second'); await state(phone.page, 'second', 'idle');
    assert.equal(await phone.page.locator('.unread-badge').count(), 0);
    await desktop.page.reload(); await state(desktop.page, 'done', 'idle'); await state(desktop.page, 'second', 'idle');
    await select(phone.page, 'worker'); assert.equal(await phone.page.getByLabel('消息输入').inputValue(), '手机未发送的草稿');
    await pin(phone.page, 'done'); await desktop.page.locator('[data-session-id="done"].pinned').waitFor();
    await pin(desktop.page, 'second'); await phone.page.locator('[data-session-id="second"].pinned').waitFor();
    await card(desktop.page, 'second').getByRole('button', { name: /拖动排序/ }).press('ArrowDown');
    await phone.page.waitForFunction(() => document.querySelector('.session-list [data-session-id]')?.dataset.sessionId === 'done');
    assert.deepEqual([...manager.sync.snapshot().layout.pinned].sort(), ['done', 'second']);

    // Task phases must agree even while each device views a different session.
    for (const [phase, color] of [['thinking', 'busy'], ['responding', 'busy'], ['waiting', 'waiting'], ['error', 'error'], ['interrupted', 'interrupted'], ['unknown', 'unknown']]) {
      transition('done', phase); await state(phone.page, 'done', color); await state(desktop.page, 'done', color);
    }
    transition('done', 'completed', 'done:2'); await state(phone.page, 'done', 'unread'); await state(desktop.page, 'done', 'unread');

    // Offline device catches up without forcing navigation or discarding input.
    await phone.context.setOffline(true);
    for (const client of wss.clients) client.close();
    await select(desktop.page, 'done'); await state(desktop.page, 'done', 'idle');
    await phone.context.setOffline(false);
    await phone.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await state(phone.page, 'done', 'idle');
    assert.equal(await phone.page.getByLabel('消息输入').inputValue(), '手机未发送的草稿');

    // A failed write is retried across a reload; it cannot read a later reply.
    let block = true;
    await phone.context.route('**/api/sessions/sync', route => block ? route.abort() : route.continue());
    transition('done', 'completed', 'done:3');
    await select(desktop.page, 'worker');
    // Desktop was looking at done when it completed, so create another turn.
    transition('done', 'completed', 'done:4'); await state(phone.page, 'done', 'unread');
    await select(phone.page, 'done');
    await phone.page.waitForFunction(() => JSON.parse(sessionStorage.getItem('web-ttyd-hub.shared-pending.v1')).length > 0);
    await select(phone.page, 'worker');
    transition('done', 'completed', 'done:5'); await state(desktop.page, 'done', 'unread');
    await phone.page.reload(); await state(phone.page, 'done', 'unread');
    block = false; await phone.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await phone.page.waitForFunction(() => JSON.parse(sessionStorage.getItem('web-ttyd-hub.shared-pending.v1')).length === 0);
    await state(desktop.page, 'done', 'unread');
    assert.notEqual(manager.sync.snapshot().read.done.completed, 'done:5');
    await select(phone.page, 'done'); await state(desktop.page, 'done', 'idle');

    // Existing lifecycle broadcasts still synchronize names and archive/restore.
    await desktop.page.bringToFront(); await sidebar(desktop.page);
    await card(desktop.page, 'done').getByLabel('会话操作菜单').click();
    await desktop.page.getByRole('button', { name: '修改名称', exact: true }).click();
    await card(desktop.page, 'done').getByLabel('会话名称 / Session name').fill('各端已读状态一致');
    heldLists.length = 0;
    await desktop.context.route('**/api/sessions', holdList);
    await card(desktop.page, 'done').getByRole('button', { name: '保存 / Save', exact: true }).click();
    for (let i = 0; !heldLists.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(heldLists.length);
    await desktop.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await card(desktop.page, 'done').locator('.rename-form').waitFor({ state: 'detached', timeout: 1500 });
    assert.equal(await card(desktop.page, 'done').getByRole('alert').count(), 0, 'Replacing a refresh must not report a successful edit as failed');
    await desktop.context.unroute('**/api/sessions', holdList);
    await Promise.all(heldLists.map(release => release()));
    await desktop.page.waitForFunction(() => document.querySelector('[data-session-id="done"] .session-name')?.textContent === '各端已读状态一致');
    manager.archive('second'); await card(desktop.page, 'second').waitFor({ state: 'detached' }); await card(phone.page, 'second').waitFor({ state: 'detached' });
    manager.restoreArchived('second'); await card(desktop.page, 'second').waitFor(); await card(phone.page, 'second').waitFor({ state: 'attached' });
    await sidebar(phone.page);
    await phone.page.locator('.sidebar').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const output = path.join(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
    await phone.page.screenshot({ path: path.join(output, 'session-sync-phone.png') });
    await desktop.page.screenshot({ path: path.join(output, 'session-sync-desktop.png') });
    await phone.page.setViewportSize({ width: 1100, height: 760 });
    await phone.page.locator('.sidebar').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    await phone.page.screenshot({ path: path.join(output, 'session-sync-preview.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: independent phone/desktop read receipts, phases, pins/order, reload, offline retry, stale receipts, drafts and lifecycle sync');
  } finally {
    await browser.close(); terminals.close(); manager.cleanup(); for (const client of wss.clients) client.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
