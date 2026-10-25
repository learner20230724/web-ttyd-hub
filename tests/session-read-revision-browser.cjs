// A final answer appended after the same turn was read must become unread
// again. Only displaying its new revision may clear that notification.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const SessionSync = require('../server/services/session-sync');
const setupWebSocket = require('../server/ws');
const contentResponse = require('../server/services/content-response');
const createdAt = '2026-10-25T00:00:00Z';
const partial = '合成已读 r1：只有早先的工作进展。';
const final = '合成晚到 r2：这条最终回答必须重新显示为未读。';

(async () => {
  const target = { name: 'late-final', displayName: '晚到最终回答', createdAt, shell: 'codex', status: 'running',
    activity: { available: true, phase: 'completed', busy: false, completed: 't2', contentRevision: 'r1' } };
  const viewer = { name: 'viewer', displayName: '另一条合成会话', createdAt, shell: 'bash', status: 'running',
    activity: { available: true, phase: 'idle', busy: false, completed: null } };
  const manager = new EventEmitter(); manager.sessions = new Map([[viewer.name, viewer], [target.name, target]]);
  manager.list = () => [...manager.sessions.values()]; manager.sync = new SessionSync(manager);
  manager.sync.restore({ revision: 1, read: { [target.name]: { createdAt, completed: 't2', contentRevision: 'r1' } },
    layout: { order: [viewer.name, target.name], pinned: [] } });
  let bodyRevision = 'r1', inputs = 0;
  const reads = [];
  const app = express(); app.use(express.json());
  app.get('/api/sessions', (_req, res) => res.json({ sessions: manager.list(), shared: manager.sync.snapshot() }));
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [{ id: 'bash', name: 'Bash' }, { id: 'codex', name: 'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.get('/api/sessions/:name/mobile', (req, res) => {
    if (req.params.name === viewer.name) return contentResponse(req, res, { text: '合成浏览页', completed: null });
    if (req.query.view === 'full') return contentResponse(req, res, { text: 'SYNTHETIC_TOOL_OUTPUT\n' + final, completed: 't2', contentRevision: 'r2' });
    contentResponse(req, res, { messages: [{ id: bodyRevision, role: 'assistant', phase: bodyRevision === 'r2' ? 'final_answer' : 'commentary',
      text: bodyRevision === 'r2' ? final : partial }], completed: 't2', contentRevision: bodyRevision });
  });
  app.post('/api/sessions/sync', (req, res) => { assert.equal(req.body.type, 'read'); reads.push(req.body); res.json(manager.sync.apply(req.body)); });
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.sendStatus(405); });
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager); await once(server, 'listening');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ createdAt }) => {
      if (!localStorage.getItem('web-ttyd-hub.last-session.v1')) localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'viewer', createdAt }));
      localStorage.setItem('web-ttyd-hub.shared-migrated.v1', '1');
      document.hasFocus = () => true;
    }, { createdAt });
    const url = `http://127.0.0.1:${server.address().port}`, errors = [];
    let page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(url);
    await page.getByText('合成浏览页', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await page.locator('.unread-badge').count(), 0, 'Previously read r1 begins as read');
    target.activity = { ...target.activity, contentRevision: 'r2' };
    manager.emit('session:activity', target);
    await page.getByRole('button', { name: '查看下一个未读会话，共 1 个', exact: true }).waitFor({ timeout: 2000 });
    await page.waitForTimeout(300);
    assert.equal(reads.length, 0, 'A background late final cannot acknowledge itself');
    // Selecting the notified conversation is an intentional read action. It is
    // never a terminal submission and cannot substitute for current content.
    await page.getByRole('button', { name: '查看下一个未读会话，共 1 个', exact: true }).tap();
    await page.getByText(partial, { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await page.locator('.mobile-reading').getAttribute('data-content-revision'), 'r1');
    await page.waitForTimeout(250);
    assert.equal(reads.length, 0, 'Opening old r1 cannot clear the notification for r2');
    assert.equal(manager.sync.snapshot().read[target.name].contentRevision, 'r1');
    bodyRevision = 'r2'; // No activity event, focus event or input rescues it.
    await page.getByText(final, { exact: true }).waitFor({ timeout: 3000 });
    for (let i = 0; i < 40 && !reads.length; i++) await page.waitForTimeout(25);
    assert.equal(reads.length, 1); assert.equal(reads[0].contentRevision, 'r2');
    assert.equal(manager.sync.snapshot().read[target.name].contentRevision, 'r2');
    await page.locator('.mobile-session-header').getByText('已完成 · 已读', { exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('web-ttyd-hub.session-metadata.v1')).readRevisions['late-final']), 'r2');
    await page.close(); page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(url);
    await page.getByText(final, { exact: true }).waitFor({ timeout: 2000 });
    await page.locator('.mobile-session-header').getByText('已完成 · 已读', { exact: true }).waitFor({ timeout: 1500 });
    assert.equal(reads.length, 1, 'Reopen restores the confirmed revision without another acknowledgement');
    assert.equal(inputs, 0); assert.deepEqual(errors, []);
    console.log('PASS read revision: background late final becomes unread, old partial stays unread, rendered r2 acknowledges once and persists through reopen; terminal inputs=0');
    await context.close();
  } finally {
    await browser.close(); wss.clients.forEach(client => client.terminate()); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
