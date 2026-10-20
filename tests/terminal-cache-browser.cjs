// Only isolated, synthetic tmux content is used; never attaches production panes.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { fixture, until, pause } = require('./terminal-fixture.cjs');

const terminalText = () => {
  const buffer = document.querySelector('.terminal-host')?.terminal?.buffer.active;
  return buffer ? Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).join('\n') : '';
};

(async () => {
  const f = await fixture();
  let browser;
  try {
    f.output('\x1b[2J\x1b[H' + Array.from({ length: 500 }, (_, i) => `PERSIST_${String(i).padStart(4, '0')} 中文 history\r\n`).join(''));
    await until(() => Number(f.tm('display-message', '-p', '-t', f.target, '#{history_size}')) > 450);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [], frames = [], blocked = [], heldLists = [];
    let hold = false, holdMetadata = false, terminalAttempts = 0, replacementList = null;
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framereceived', event => {
      if (typeof event.payload === 'string') { try { frames.push(JSON.parse(event.payload)); } catch {} }
    }));
    await page.routeWebSocket('**/ws/terminal/**', socket => {
      terminalAttempts++;
      if (hold) blocked.push(socket);
      else socket.connectToServer();
    });
    await page.routeWebSocket('**/ws', socket => {
      if (holdMetadata) socket.close(); else socket.connectToServer();
    });
    const respondList = route => replacementList
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(replacementList) })
      : route.continue();
    await page.route('**/api/sessions', route => {
      if (holdMetadata) heldLists.push(route); else return respondList(route);
    });
    await page.goto(f.base);
    await page.locator('.session-card').click();
    await page.waitForFunction(() => document.querySelector('.terminal-host')?.terminal?.options.disableStdin === false);
    await page.waitForFunction(terminalText => {
      const t = document.querySelector('.terminal-host').terminal, b = t.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)).join('\n').includes('PERSIST_0499');
    });
    f.output('DURABLE_LIVE_TAIL\r\n\x1b[6n');
    await page.waitForFunction(() => {
      const b = document.querySelector('.terminal-host').terminal.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)).join('\n').includes('DURABLE_LIVE_TAIL');
    });
    await pause(100);
    const inputBeforeReopen = f.input().length;
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForFunction(() => new Promise(resolve => {
      const request = indexedDB.open('ttyd-hub-content-v1', 1);
      request.onsuccess = () => {
        const db = request.result, records = db.transaction('content').objectStore('content').getAll();
        records.onsuccess = () => { resolve(records.result.some(row => row.data?.version === 1 && row.data.updates?.length)); db.close(); };
      };
      request.onerror = () => resolve(false);
    }));
    hold = true; holdMetadata = true;
    const attemptsBeforeCachedList = terminalAttempts;
    await page.reload();
    await page.waitForFunction(() => {
      const b = document.querySelector('.terminal-host')?.terminal?.buffer.active;
      return b && Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)).join('\n').includes('DURABLE_LIVE_TAIL');
    });
    const cached = await page.evaluate(terminalText);
    assert(cached.includes('PERSIST_0000') && cached.includes('PERSIST_0499'));
    assert.equal(cached.split('DURABLE_LIVE_TAIL').length - 1, 1);
    assert.equal(await page.evaluate(() => document.querySelector('.terminal-host').terminal.options.disableStdin), true);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('MUST_NOT_SEND');
    await pause(150);
    assert.equal(f.input().length, inputBeforeReopen, 'Cached queries and typing must not reach the PTY before live validation');
    assert.equal(terminalAttempts, attemptsBeforeCachedList, 'Cached metadata cannot open a live terminal before its generation is confirmed');
    holdMetadata = false;
    await Promise.all(heldLists.splice(0).map(respondList));
    await until(() => blocked.length > 0);
    f.output('MISSED_WHILE_DISCONNECTED\r\n');
    hold = false;
    for (const socket of blocked) socket.close();
    await page.waitForFunction(() => document.querySelector('.terminal-host')?.terminal?.options.disableStdin === false);
    await page.waitForFunction(() => {
      const b = document.querySelector('.terminal-host').terminal.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)).join('\n').includes('MISSED_WHILE_DISCONNECTED');
    });
    const recovered = await page.evaluate(terminalText);
    assert.equal(recovered.split('DURABLE_LIVE_TAIL').length - 1, 1);
    assert.equal(recovered.split('MISSED_WHILE_DISCONNECTED').length - 1, 1);
    const delta = frames.find(frame => frame.type === 'snapshot-delta');
    assert(delta, 'Cached desktop reconnect must receive a patch instead of downloading unchanged history');
    const full = frames.find(frame => frame.type === 'snapshot');
    const bytes = { full: Buffer.byteLength(JSON.stringify(full)), delta: Buffer.byteLength(JSON.stringify(delta)) };
    assert(bytes.delta < bytes.full / 4, JSON.stringify(bytes));
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForFunction(() => new Promise(resolve => {
      const request = indexedDB.open('ttyd-hub-content-v1', 1);
      request.onsuccess = () => {
        const db = request.result, records = db.transaction('content').objectStore('content').getAll();
        records.onsuccess = () => { resolve(records.result.some(row => row.data?.snapshot?.screen?.includes('MISSED_WHILE_DISCONNECTED'))); db.close(); };
      };
      request.onerror = () => resolve(false);
    }));
    const beforeColdOpen = frames.length;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.terminal-host')?.terminal?.options.disableStdin === false);
    assert(frames.slice(beforeColdOpen).some(frame => frame.type === 'snapshot-delta'),
      'A normal cold reopen must advertise the on-disk baseline before downloading history');
    assert.equal((await page.evaluate(terminalText)).split('MISSED_WHILE_DISCONNECTED').length - 1, 1);
    // A replacement with the same name is rejected before any socket opens;
    // cached content is never rebound to the replacement's output or identity.
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const actualList = await f.api();
    replacementList = { ...actualList, sessions: actualList.sessions.map(session => session.name === f.session.name
      ? { ...session, createdAt: `${session.createdAt}:replacement` } : session) };
    holdMetadata = true;
    const attemptsBeforeReplacement = terminalAttempts;
    await page.reload();
    await page.waitForFunction(() => {
      const b = document.querySelector('.terminal-host')?.terminal?.buffer.active;
      return b && Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)).join('\n').includes('MISSED_WHILE_DISCONNECTED');
    });
    assert.equal(await page.evaluate(() => document.querySelector('.terminal-host').terminal.options.disableStdin), true);
    holdMetadata = false;
    await Promise.all(heldLists.splice(0).map(respondList));
    await page.locator('.terminal-host').waitFor({ state: 'detached' });
    assert.equal(terminalAttempts, attemptsBeforeReplacement, 'Reused session names must never attach through stale metadata');
    // A storage provider that never completes must not hold the live terminal.
    const stalledStorage = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await stalledStorage.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: { open: () => ({}) } });
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => timeout(callback, delay === 500 ? 5000 : delay, ...args);
    });
    const fresh = await stalledStorage.newPage();
    fresh.on('pageerror', error => errors.push(error.message));
    await fresh.goto(f.base);
    await fresh.locator('.session-card').click();
    await fresh.waitForFunction(() => document.querySelector('.terminal-host')?.terminal?.options.disableStdin === false, null, { timeout: 2000 });
    assert((await fresh.evaluate(terminalText)).includes('MISSED_WHILE_DISCONNECTED'));
    await stalledStorage.close();
    assert.equal(f.tm('display-message', '-p', '-t', f.target, '#{pane_pid}'), f.pid);
    assert.deepEqual(errors, []);
    console.log('PASS: persisted desktop cache restores before metadata/terminal connection, input/query replies stay disabled, generations are validated before attaching, missing output is patched without duplicates, stalled storage cannot block live access, live process retained', bytes);
  } finally { await browser?.close(); await f.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
