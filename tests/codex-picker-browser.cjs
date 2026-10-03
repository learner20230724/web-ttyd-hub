// Browser regression with synthetic projects/history only; never launches Codex.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once, EventEmitter } = require('node:events');
const express = require('express');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const root = path.join(__dirname, '..');
const output = path.join(root, 'output/playwright');
const idA = '01900000-0000-7000-8000-000000000001', idB = '01900000-0000-7000-8000-000000000002';
const app = express(); app.use(express.json());
let platform, sessions = [], requests = [];
const projects = () => platform === 'win32' ? ['C:\\Projects\\中文 A', 'C:\\Projects\\B'] : ['/srv/projects/中文 A', '/srv/projects/B'];
app.get('/api/sessions', (_req, res) => res.json({ sessions }));
app.get('/api/sessions/shells', (_req, res) => res.json({ platform, shells: [{ id: 'codex', name: 'Codex' }] }));
app.get('/api/sessions/projects', (_req, res) => res.json({ projects: projects().map((p, i) => ({ name: `项目 ${i ? 'B' : 'A'}`, path: p, sessionCount: 1 })) }));
app.get('/api/sessions/codex-history', (req, res) => {
  const b = req.query.cwd === projects()[1];
  const row = { id: b ? idB : idA, title: b ? 'B 修复历史' : 'A 旧会话', updatedAt: '2026-10-03T00:00:00Z' };
  const found = !req.query.q || row.title.includes(req.query.q);
  res.json({ sessions: found ? [row] : [], total: found ? 1 : 0, nextOffset: null });
});
app.get('/api/sessions/codex-history/:id', (req, res) => {
  const b = req.params.id === idB;
  setTimeout(() => res.json({ id: req.params.id, messages: [{ role: 'user', text: b ? '<img src=x onerror=alert(1)> B question' : 'STALE A PREVIEW' }, { role: 'assistant', text: b ? 'B answer' : 'A answer' }] }), b ? 10 : 250);
});
app.post('/api/sessions', (req, res) => {
  requests.push(req.body);
  const session = { name: 'fixture-session-' + requests.length, displayName: req.body.name || '恢复会话', shell: 'codex', status: 'stopped', createdAt: new Date().toISOString() };
  sessions.push(session); res.status(201).json(session);
});
app.use(express.static(path.join(root, 'server/public')));
app.get('/', (_req, res) => res.sendFile(path.join(root, 'server/public/index.html')));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = app.listen(0, '127.0.0.1'); setupWebSocket(server, new EventEmitter());
  await once(server, 'listening');
  const browser = await chromium.launch();
  try {
    for (const target of ['linux', 'win32']) {
      platform = target; sessions = []; requests = [];
      const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('button', { name: /Create First Session/ }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      const project = page.getByLabel('Codex 项目目录');
      const history = page.getByLabel('选择 Codex 历史会话');
      await page.waitForFunction(() => document.querySelector('select[aria-label="选择 Codex 历史会话"]')?.options.length === 2);
      await history.selectOption(idA);
      await project.selectOption(projects()[1]);
      await page.waitForFunction(id => [...document.querySelector('select[aria-label="选择 Codex 历史会话"]').options].some(o => o.value === id), idB);
      assert.equal(await history.inputValue(), '', 'Changing project must clear the previous thread');
      await page.getByLabel('历史会话（当前服务器 · 当前项目）').fill('no-match');
      await page.waitForFunction(() => document.querySelector('select[aria-label="选择 Codex 历史会话"]').options.length === 1);
      await page.getByLabel('历史会话（当前服务器 · 当前项目）').fill('B');
      await page.waitForFunction(() => document.querySelector('select[aria-label="选择 Codex 历史会话"]').options.length === 2);
      await history.selectOption(idB);
      await page.getByText('B answer', { exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.getByText('STALE A PREVIEW', { exact: true }).count(), 0);
      assert.equal(await page.locator('.history-preview img').count(), 0, 'Preview must not render HTML');
      await page.screenshot({ path: path.join(output, `codex-picker-${target}.png`), fullPage: true });
      await page.getByRole('button', { name: '恢复 / 打开会话', exact: true }).click();
      await page.waitForSelector('.modal-overlay', { state: 'detached' });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].cwd, projects()[1]); assert.equal(requests[0].resumeThreadId, idB);
      assert.deepEqual(errors, []);
      console.log(`PASS ${target}: project/history selection, search, safe preview, stale response and resume submission`);
      await context.close();
    }
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
