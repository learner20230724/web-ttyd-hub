// Production mobile renderer + durable IndexedDB + real HTTP delta responses.
// All histories, status events and inputs below belong to this synthetic fixture.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { chromium } = require('playwright');
const setupWebSocket = require('../server/ws');
const SessionSync = require('../server/services/session-sync');
const contentResponse = require('../server/services/content-response');
const serveFrontend = require('../server/services/frontend-static');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 120; i++) { if (await predicate()) return; await pause(25); }
  throw Error('Timed out: ' + label);
}

(async () => {
  const session = { name:'content-cache-fixture', displayName:'正文差异缓存合成会话', createdAt:'2026-10-20T00:00:00Z',
    shell:'codex', status:'running', activity:{ available:true, detected:true, busy:false, phase:'completed', completed:'fixture-turn' } };
  const manager = new EventEmitter();
  manager.sessions = new Map([[session.name, session]]); manager.list = () => [session];
  manager.sync = new SessionSync(manager);
  manager.sync.restore({ revision:1, read:{ [session.name]:{ createdAt:session.createdAt, completed:session.activity.completed } },
    layout:{ order:[session.name], pinned:[] } });
  const lines = Array.from({ length:1200 }, (_, i) => `CACHE_ROW_${String(i).padStart(4, '0')} 历史内容 ${i * 728391} 中文 🙂\n`).join('');
  const initial = 'START_OF_CACHED_HISTORY\n' + lines + 'END_OF_CACHED_HISTORY\n';
  let suffix = '', ansiSuffix = '', corruptNextPatch = false, inputs = 0;
  const records = [];
  const fullData = () => ({ text:initial + suffix, ansi:'\x1b[36m' + initial + '\x1b[0m' + ansiSuffix,
    inputReceipts:[], completed:session.activity.completed });
  const app = express(); app.use(express.json());
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/sessions', (_req, res) => res.json({ sessions:[session], shared:manager.sync.snapshot() }));
  app.get('/api/sessions/shells', (_req, res) => res.json({ platform:'linux', shells:[{ id:'codex', name:'Codex' }] }));
  app.get('/api/sessions/:name/questions', (_req, res) => res.json({ supported:false, requests:[] }));
  const sendContent = contentResponse.create();
  app.get('/api/sessions/:name/mobile', (req, res) => {
    assert.equal(req.params.name, session.name);
    assert.equal(req.headers['x-ttyd-generation'], session.createdAt, 'The browser must validate the cached session generation');
    const full = req.query.view === 'full';
    let wirePayload, corrupted = false;
    const json = res.json;
    res.json = function (body) {
      if (full && corruptNextPatch && body.delta) {
        corruptNextPatch = false; corrupted = true;
        body = JSON.parse(JSON.stringify(body));
        const splice = body.delta.splices.ansi;
        assert.ok(splice?.insert.includes('RECOVERY_APPEND'), 'The corrupt response still has a valid field-splice structure');
        // Preserve valid JSON/UTF-16 and the original strong target ETag. Only
        // a final content checksum can detect this well-formed damaged patch.
        splice.insert = splice.insert.replace('RECOVERY_APPEND', 'TAMPERED_APPEND');
      }
      wirePayload = body;
      return json.call(this, body);
    };
    res.on('finish', () => records.push({ view:full ? 'full' : 'answer', status:res.statusCode,
      base:req.headers['if-none-match'], protocol:req.headers['x-ttyd-delta'], generation:req.headers['x-ttyd-generation'],
      etag:res.getHeader('ETag'), bytes:Number(res.getHeader('Content-Length') || 0), delta:wirePayload?.delta, corrupted }));
    sendContent(req, res, full ? fullData() : { messages:[{ id:'answer', role:'assistant', phase:'final_answer', text:'合成回答' }],
      inputReceipts:[], completed:session.activity.completed }, JSON.stringify([session.name, session.createdAt, full ? 'full' : 'answer']));
  });
  app.post('/api/sessions/:name/input', (_req, res) => { inputs++; res.json({ ok:true }); });
  app.post('/api/sessions/sync', (req, res) => res.json(manager.sync.apply(req.body)));
  serveFrontend(app, path.join(__dirname, '../server/public'));
  const server = app.listen(0, '127.0.0.1'), wss = setupWebSocket(server, manager);
  await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ headless:true, args:['--no-sandbox'] });
    const context = await browser.newContext({ viewport:{ width:412, height:915 }, isMobile:true, hasTouch:true });
    await context.addInitScript(({ name, createdAt }) => {
      if (!localStorage.getItem('web-ttyd-hub.last-session.v1')) localStorage.setItem('web-ttyd-hub.last-session.v1', JSON.stringify({ name, createdAt }));
      if (!localStorage.getItem('web-ttyd-hub.mobile-reading.v1')) localStorage.setItem('web-ttyd-hub.mobile-reading.v1', JSON.stringify({ showExecution:true }));
    }, { name:session.name, createdAt:session.createdAt });
    const url = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    const open = async () => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('.terminal-segments')?.textContent.includes('END_OF_CACHED_HISTORY'));
      return page;
    };
    const diskEntry = async page => page.evaluate(async ({ name, createdAt }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('ttyd-hub-content-v1', 1);
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const req = db.transaction('content').objectStore('content').get(JSON.stringify([name, createdAt, 'full']));
          req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error);
        });
      } finally { db.close(); }
    }, { name:session.name, createdAt:session.createdAt });
    const assertAllHistory = async page => {
      const output = await page.locator('.terminal-segments').textContent();
      assert(output.includes('START_OF_CACHED_HISTORY') && output.includes('END_OF_CACHED_HISTORY'));
      assert.equal((output.match(/CACHE_ROW_\d{4}/g) || []).length, 1200, 'No old history lines may disappear or duplicate');
      assert(!output.includes('TAMPERED_APPEND'));
      assert(!output.includes('\x1b'), 'ANSI escape sequences are rendered, not printed');
    };

    let page = await open();
    await until(() => records.some(record => record.view === 'full' && record.status === 200), 'initial full response');
    const first = records.find(record => record.view === 'full' && record.status === 200);
    assert.equal(first.base, undefined);
    assert.equal(first.delta, undefined);
    assert.equal(first.bytes, Buffer.byteLength(JSON.stringify(fullData())));
    await until(async () => (await diskEntry(page))?.etag === first.etag, 'initial response committed to IndexedDB');
    await assertAllHistory(page);
    await page.close();

    const coldStart = records.length;
    page = await open();
    await until(() => records.slice(coldStart).some(record => record.view === 'full'), 'cold reopen conditional response');
    const cold = records.slice(coldStart).find(record => record.view === 'full');
    assert.equal(cold.base, first.etag, 'A new page process must reuse the ETag loaded from persistent disk');
    assert.equal(cold.protocol, 'fields-v1');
    assert.equal(cold.status, 304);
    assert.equal(cold.bytes, 0);
    await assertAllHistory(page);
    await page.close();
    console.log('PASS cold reopen uses persisted ETag, receives 304 and transfers zero history body bytes');

    suffix += 'UNICODE_APPEND_新的输出_🙂🙃_e\u0301\n';
    ansiSuffix += '\x1b[1;32m' + suffix + '\x1b[0m';
    const appendStart = records.length;
    page = await open();
    await page.waitForFunction(() => document.querySelector('.terminal-segments')?.textContent.includes('UNICODE_APPEND_新的输出_🙂🙃_e\u0301'));
    await until(() => records.slice(appendStart).some(record => record.delta), 'Unicode append delta response');
    const patch = records.slice(appendStart).find(record => record.delta);
    assert.equal(patch.status, 200);
    assert.equal(patch.base, first.etag);
    assert.ok(patch.delta.splices.text && patch.delta.splices.ansi);
    const fullBytes = Buffer.byteLength(JSON.stringify(fullData()));
    assert(patch.bytes < fullBytes / 10, `Expected >90% reduction: patch=${patch.bytes}, full=${fullBytes}`);
    await assertAllHistory(page);
    const colored = await page.locator('.mobile-output span').filter({ hasText:'UNICODE_APPEND_' }).last().evaluate(element => ({
      color:getComputedStyle(element).color, weight:getComputedStyle(element).fontWeight,
    }));
    assert.equal(colored.weight, '700', 'ANSI bold formatting must survive the field patch');
    assert.equal(colored.color, 'rgb(138, 226, 52)', 'ANSI bold green must survive the field patch');
    await until(async () => {
      const entry = await diskEntry(page);
      return entry?.etag === patch.etag && entry.data.text === fullData().text && entry.data.ansi === fullData().ansi;
    }, 'reconstructed full content committed to disk');
    await page.close();
    console.log('PASS production mobile client reconstructs complete Unicode/ANSI history and saves the checked result');

    suffix += 'RECOVERY_APPEND_哈希校验恢复_🚀\n';
    ansiSuffix += '\x1b[1;35mRECOVERY_APPEND_哈希校验恢复_🚀\x1b[0m\n';
    corruptNextPatch = true;
    const recoveryStart = records.length;
    page = await open();
    await page.waitForFunction(() => document.querySelector('.terminal-segments')?.textContent.includes('RECOVERY_APPEND_哈希校验恢复_🚀'));
    await until(() => records.slice(recoveryStart).some(record => record.view === 'full' && !record.base && record.status === 200), 'unconditional recovery');
    const recovery = records.slice(recoveryStart).filter(record => record.view === 'full');
    const bad = recovery.find(record => record.corrupted), fixed = recovery.find(record => !record.base && record.status === 200);
    assert.ok(bad?.delta);
    assert.equal(bad.base, patch.etag);
    assert.equal(fixed.protocol, undefined, 'Recovery must omit both conditional and delta negotiation headers');
    assert.equal(fixed.delta, undefined);
    assert.equal(recovery.indexOf(fixed), recovery.indexOf(bad) + 1, 'A damaged patch receives exactly one immediate unconditional retry');
    await assertAllHistory(page);
    await until(async () => {
      const entry = await diskEntry(page);
      return entry?.etag === fixed.etag && entry.data.text === fullData().text && entry.data.ansi === fullData().ansi &&
        !JSON.stringify(entry.data).includes('TAMPERED_APPEND');
    }, 'recovered baseline replaces disk content without storing the damaged patch');
    assert.equal(records.filter(record => record.view === 'answer').length, 0, 'Full readers do not prefetch unseen answer histories');
    assert.equal(inputs, 0, 'Reading caches and repairing patches never sends terminal input');
    assert.deepEqual(errors, []);
    console.log('PASS a well-formed tampered patch fails SHA256 and recovers with an unconditional full response');
    console.log('MEASURE mobile-history-body-bytes ' + JSON.stringify({ initialFull:first.bytes, unchangedColdReopen:cold.bytes,
      changedFull:fullBytes, changedDelta:patch.bytes, savedPercent:Number(((1 - patch.bytes / fullBytes) * 100).toFixed(2)) }));
    await context.close();
  } finally {
    await browser?.close();
    for (const client of wss.clients) client.terminate();
    wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
