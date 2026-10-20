// Prove read receipts require visible current content, including cold metadata
// restoration before the lazily loaded terminal renderer has even arrived.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const SessionSync = require('../server/services/session-sync');
const syntheticTerminals = require('./synthetic-terminal.cjs');
const { until, pause } = require('./terminal-fixture.cjs');

(async () => {
  const createdAt = '2026-10-20T00:00:00Z';
  const session = { name: 'reader', displayName: '合成已读验证', createdAt, shell: 'codex', status: 'running',
    activity: { available: true, detected: true, phase: 'completed', busy: false, completed: 't1' } };
  const manager = new EventEmitter(); manager.sessions = new Map([[session.name, session]]); manager.list = () => [session];
  manager.sync = new SessionSync(manager);
  manager.sync.restore({ revision: 1, read: { reader: { createdAt, completed: 't1' } }, layout: { order: ['reader'], pinned: [] } });
  let readWrites = 0;
  const app = express(); app.use(express.json());
  app.get('/api/sessions', (_req, res) => res.json({ sessions: manager.list(), shared: manager.sync.snapshot() }));
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform: 'linux', shells: [] }));
  app.post('/api/sessions/sync', (req, res) => { if (req.body.type === 'read') readWrites++; res.json(manager.sync.apply(req.body)); });
  app.use(express.static(path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const wss = setupWebSocket(server, manager), terminals = syntheticTerminals(server, manager);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.addInitScript(({ createdAt }) => {
      if (!localStorage.getItem('web-ttyd-hub.last-session.v1')) localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'reader', createdAt }));
      localStorage.setItem('web-ttyd-hub.shared-migrated.v1', '1');
    }, { createdAt });
    const errors = [], blocked = [], chunks = [];
    let holdTerminal = false, holdChunk = false;
    await context.routeWebSocket('**/ws/terminal/**', route => { if (holdTerminal) blocked.push(route); else route.connectToServer(); });
    await context.route('**/TerminalView-*.js', route => { if (holdChunk) chunks.push(route); else return route.continue(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    let page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('.terminal-host')?.terminal?.options.disableStdin === false);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForFunction(() => new Promise(resolve => {
      const open = indexedDB.open('ttyd-hub-content-v1', 1);
      open.onsuccess = () => {
        const db = open.result, request = db.transaction('content').objectStore('content').getAll();
        request.onsuccess = () => { resolve(request.result.some(row => row.data?.snapshot?.completed === 't1')); db.close(); };
      };
    }));
    await page.close();
    session.activity = { ...session.activity, completed: 't2' };
    holdChunk = true; holdTerminal = true;
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await until(() => chunks.length > 0);
    await page.locator('[data-session-id="reader"] .activity-badge.unread').first().waitFor();
    await pause(150);
    assert.equal(await page.locator('.terminal-host').count(), 0);
    assert.equal(readWrites, 0, 'A fresh list cannot read a reply before the terminal renderer loads');
    holdChunk = false; await Promise.all(chunks.splice(0).map(route => route.continue()));
    await page.waitForFunction(() => {
      const b = document.querySelector('.terminal-host')?.terminal?.buffer.active;
      return b && Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)).join('\n').includes('FINAL_t1');
    });
    assert.equal(await page.evaluate(() => document.querySelector('.terminal-host').terminal.options.disableStdin), true);
    await pause(150);
    assert.equal(readWrites, 0, 'Cached t1 cannot mark fresh t2 read while its terminal connection is held');
    assert.equal(manager.sync.snapshot().read.reader.completed, 't1');
    holdTerminal = false; for (const socket of blocked) socket.close();
    await until(() => manager.sync.snapshot().read.reader.completed === 't2');
    assert.equal(readWrites, 1);
    // New completions on an already-open connection require a new checkpoint.
    terminals.hold(true);
    session.activity = { ...session.activity, completed: 't3' }; manager.emit('session:activity', session);
    await until(() => terminals.pending.length > 0); await pause(150);
    assert.equal(manager.sync.snapshot().read.reader.completed, 't2');
    terminals.hold(false);
    await until(() => manager.sync.snapshot().read.reader.completed === 't3');
    // Reading old scrollback does not acknowledge the latest reply. Returning
    // to the bottom acknowledges the checkpoint that is already rendered.
    await page.evaluate(() => document.querySelector('.terminal-host').terminal.scrollToTop());
    await page.waitForFunction(() => {
      const b = document.querySelector('.terminal-host').terminal.buffer.active;
      return b.baseY > 0 && b.viewportY === 0;
    });
    session.activity = { ...session.activity, completed: 't4' }; manager.emit('session:activity', session);
    await until(() => terminals.snapshots.some(snapshot => snapshot.completed === 't4'));
    await page.waitForFunction(() => {
      const b = document.querySelector('.terminal-host').terminal.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)).join('\n').includes('FINAL_t4');
    });
    await pause(150); assert.equal(manager.sync.snapshot().read.reader.completed, 't3');
    await page.evaluate(() => document.querySelector('.terminal-host').terminal.scrollToBottom());
    await until(() => manager.sync.snapshot().read.reader.completed === 't4');
    assert.deepEqual(errors, []);
    console.log('PASS: lazy renderer and cached t1 cannot read fresh t2; authoritative render/checkpoint and scrolling to latest acknowledge exactly the displayed completion');
  } finally {
    await browser.close(); terminals.close(); for (const client of wss.clients) client.terminate(); wss.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
