// Lost one-shot WebView timers, stable server lamps, slow view changes, and no input.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright');
(async () => {
  const app = express(); let ready = false, inputs = 0, reads = 0, delayFull = false;
  const session = { name: 'passive', createdAt: 'fixture', displayName: '自动读取测试', status: 'running', shell: 'codex',
    activity: { detected: true, available: true, phase: 'completed', busy: false, completed: 'same-turn' } };
  app.get('/api/sessions', (_req, res) => res.json({ sessions: [session] }));
  app.get('/api/sessions/shells', (_req, res) => res.json({ shells: [] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported: false, requests: [] }));
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.sendStatus(405); });
  app.post('/api/sessions/sync', (_req, res) => res.sendStatus(405));
  app.get('/api/sessions/:name/mobile', (req, res) => {
    reads++;
    const full = req.query.view === 'full';
    const data = full ? { text: 'FULL_EXECUTION_LOG' } : { messages: [{ id: 'reply', role: 'assistant', text: ready ? 'FINAL_WITHOUT_NEW_INPUT' : 'OLD_REPLY' }] };
    const send = () => { if (!res.destroyed) res.json({ ...data, completed: 'same-turn' }); };
    if (full && delayFull) setTimeout(send, 900); else send();
  });
  app.use(express.static(process.env.HUB_PUBLIC_DIR || path.join(__dirname, '../server/public')));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name: 'passive', createdAt: 'fixture' }));
      document.hasFocus = () => false;
      // Reproduce a lost chained reader timer, with no foreground/focus rescue.
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => timeout([1200, 5000, 15000].includes(ms) ? () => {} : fn, ms, ...args);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText('OLD_REPLY', { exact: true }).waitFor();
    ready = true;
    await page.getByText('FINAL_WITHOUT_NEW_INPUT', { exact: true }).waitFor({ timeout: 7000 });
    assert(reads >= 2); assert.equal(inputs, 0);
    delayFull = true;
    const answer = page.getByRole('button', { name: '隐藏执行过程', exact: true });
    const full = page.getByRole('button', { name: '显示执行过程', exact: true });
    for (let i = 0; i < 3; i++) {
      await full.tap(); assert.equal(await full.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.mobile-reading').getAttribute('data-view'), 'full');
      await answer.tap();
      await page.getByText('FINAL_WITHOUT_NEW_INPUT', { exact: true }).waitFor({ timeout: 1000 });
      await page.waitForTimeout(1000);
      assert.equal(await page.locator('.mobile-reading').getAttribute('data-view'), 'answer');
      assert.equal(await page.getByText('FULL_EXECUTION_LOG', { exact: true }).count(), 0, 'Late full response cannot overwrite answer');
    }
    const before = reads; await answer.tap();
    await page.waitForTimeout(300); assert(reads > before, 'Tapping the active view rechecks it without terminal input');
    await full.tap(); await page.getByText('FULL_EXECUTION_LOG', { exact: true }).waitFor();
    const boxes = await Promise.all([answer, full].map(x => x.boundingBox()));
    assert(boxes.every(x => x.x >= 0 && x.x + x.width <= 360));
    assert.equal(inputs, 0); assert.deepEqual(errors, []);
    console.log('PASS lost timer recovers without input; stable completion catches up; rapid and repeated view taps work at 360px');
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
