const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const express = require('express');
const contentResponse = require('../server/services/content-response');
const sessionRoutes = require('../server/routes/sessions');

const serialized = ({ capturedAt, activity, ...content }) => JSON.stringify(content);
const hash = value => '"' + createHash('sha256').update(value).digest('hex') + '"';
const longText = Array.from({ length:1600 }, (_, i) => `第 ${i} 行: ${i * 728391} 终端日志 🙂\n`).join('');
function response(send, data, { scope = 'session:one:answer', base, headers = {}, optIn = true } = {}) {
  const req = { headers:{ ...(optIn ? { 'x-ttyd-delta':'fields-v1' } : {}),
    ...(base ? { 'if-none-match':base } : {}), ...headers } };
  const res = { headers:{}, code:200, set(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; }, end() {}, json(value) { this.data = value; } };
  send(req, res, data, scope); return res;
}
function merged(old, result) {
  if (!result.data.delta) return result.data;
  const patch = result.data.delta;
  const source = serialized(old), target = JSON.parse(source);
  assert.equal(patch.format, 'fields-v1');
  assert.equal(patch.base, hash(source));
  assert.equal(patch.etag, result.headers.ETag);
  for (const key of patch.remove) delete target[key];
  for (const [key, splice] of Object.entries(patch.splices)) {
    assert.ok(Object.hasOwn(target, key));
    const field = JSON.stringify(target[key]);
    const value = JSON.parse(field.slice(0, splice.start) + splice.insert + field.slice(splice.start + splice.deleteCount));
    Object.defineProperty(target, key, { value, writable:true, configurable:true, enumerable:true });
  }
  for (const [key, value] of Object.entries(patch.set)) {
    Object.defineProperty(target, key, { value, writable:true, configurable:true, enumerable:true });
  }
  const ordered = {};
  for (const key of patch.keys) {
    assert.ok(Object.hasOwn(target, key));
    Object.defineProperty(ordered, key, { value:target[key], writable:true, configurable:true, enumerable:true });
  }
  assert.equal(hash(JSON.stringify(ordered)), patch.etag, 'Reassembled content must match the strong ETag');
  return ordered;
}

test('conditional full responses remain compatible and transient state never invalidates text', () => {
  const send = contentResponse.create();
  const original = { text:longText, completed:null, capturedAt:'one', activity:{ busy:true } };
  const first = response(send, original, { optIn:false });
  assert.deepEqual(first.data, original);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  const changed = response(send, { ...original, text:longText + 'one more line' }, { base:first.headers.ETag, optIn:false });
  assert.equal(changed.data.delta, undefined, 'Legacy clients always receive their existing response shape');
  const current = response(send, { ...changed.data, capturedAt:'later', activity:{ busy:false } }, { base:changed.headers.ETag });
  assert.equal(current.code, 304);
  assert.equal(current.data, undefined);
  assert.equal(current.headers.ETag, changed.headers.ETag);
  const unscoped = response(send, { text:longText }, { scope:null });
  assert.equal(response(send, { text:longText + 'new' }, { scope:null, base:unscoped.headers.ETag }).data.delta, undefined);
});

test('one terminal append uses fewer response bytes while preserving text, ANSI and completion', t => {
  const send = contentResponse.create();
  const before = { name:'one', text:longText, ansi:'\x1b[32m' + longText + '\x1b[0m', completed:null };
  const first = response(send, before);
  const after = { ...before, text:longText + '完成 🚀\n', ansi:before.ansi + '\x1b[1m完成 🚀\x1b[0m\n', completed:'finished-turn' };
  const next = response(send, after, { base:first.headers.ETag });
  assert.ok(next.data.delta);
  assert.deepEqual(merged(before, next), after);
  const full = Buffer.from(JSON.stringify(after)), patch = Buffer.from(JSON.stringify(next.data));
  assert.ok(patch.length < full.length * 0.1, `Patch ${patch.length} should be below 10% of full ${full.length}`);
  assert.ok(gzipSync(patch).length < gzipSync(full).length * 0.1);
  t.diagnostic(`Terminal append bytes: full=${full.length}, delta=${patch.length}; gzip full=${gzipSync(full).length}, delta=${gzipSync(patch).length}`);
});

test('answer append preserves message IDs, input receipts and completed-token semantics', () => {
  const send = contentResponse.create();
  const before = { messages:[{ id:'old', role:'assistant', text:longText }], inputReceipts:[], completed:null };
  const first = response(send, before);
  const after = { messages:[...before.messages, { id:'new', role:'assistant', text:'最终回答' }],
    inputReceipts:[{ id:'input-1', accepted:true }], completed:'turn-1' };
  const next = response(send, after, { base:first.headers.ETag });
  assert.ok(next.data.delta);
  assert.deepEqual(merged(before, next), after);
  assert.ok(Buffer.byteLength(JSON.stringify(next.data)) < Buffer.byteLength(JSON.stringify(after)) / 20);
});

test('UTF-16 splices correctly change emoji, escaped ANSI and quoted JSON content', () => {
  const send = contentResponse.create();
  for (const [old, added] of [
    ['🙂', '🙃'], ['\x1b[31m红色\x1b[0m', '\x1b[32m绿色\x1b[0m'],
    ['a "quote"\n\\path', 'a "new quote"\n\\另一个路径'],
  ]) {
    const before = { text:longText + old };
    const first = response(send, before);
    const after = { text:longText + added };
    const next = response(send, after, { base:first.headers.ETag });
    assert.ok(next.data.delta);
    // Serialize/parse the patch itself to include the actual HTTP JSON escaping.
    next.data = JSON.parse(JSON.stringify(next.data));
    assert.deepEqual(merged(before, next), after);
  }
});

test('field sets, removals and root key reordering preserve the exact hashed target', () => {
  const send = contentResponse.create();
  const before = { text:longText, obsolete:'gone', count:1, flags:{ enabled:true } };
  const first = response(send, before);
  const after = { count:2, added:{ nested:['new', null] }, text:longText, flags:null };
  const next = response(send, after, { base:first.headers.ETag });
  assert.ok(next.data.delta);
  assert.deepEqual(next.data.delta.keys, Object.keys(after));
  assert.deepEqual(next.data.delta.remove, ['obsolete']);
  assert.equal(next.data.delta.set.count, 2);
  assert.deepEqual(next.data.delta.set.added, after.added);
  assert.equal(next.data.delta.set.flags, null);
  assert.deepEqual(merged(before, next), after);
  const reordered = { text:after.text, flags:after.flags, added:after.added, count:after.count };
  const last = response(send, reordered, { base:next.headers.ETag });
  assert.ok(last.data.delta);
  assert.deepEqual(merged(after, last), reordered);
  assert.deepEqual(Object.keys(merged(after, last)), Object.keys(reordered));
});

test('source shape transitions can retain unchanged fields and replace the remaining shape', () => {
  const send = contentResponse.create();
  const before = { text:'Legacy terminal fallback', retained:longText, completed:null };
  const first = response(send, before);
  const after = { messages:[{ id:'reply', role:'assistant', text:'Recovered answer' }], completed:'turn-1', retained:longText };
  const next = response(send, after, { base:first.headers.ETag });
  assert.ok(next.data.delta);
  assert.deepEqual(next.data.delta.remove, ['text']);
  assert.deepEqual(merged(before, next), after);
});

test('special own-property names are ordinary data and never mutate object prototypes', () => {
  const send = contentResponse.create();
  const before = JSON.parse(JSON.stringify({ text:longText, safe:true }).replace('"safe":true', '"__proto__":{"previous":true},"constructor":{"previous":true}'));
  const after = JSON.parse(JSON.stringify({ text:longText, safe:true }).replace('"safe":true', '"__proto__":{"polluted":true},"constructor":{"changed":true},"toString":"own"'));
  const first = response(send, before);
  const next = response(send, after, { base:first.headers.ETag });
  assert.ok(next.data.delta);
  assert.ok(Object.hasOwn(next.data.delta.set, '__proto__'));
  assert.equal(Object.getPrototypeOf(next.data.delta.set), null);
  next.data = JSON.parse(JSON.stringify(next.data));
  assert.deepEqual(merged(before, next), after);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test('terminal front truncation and complete source rollover fall back without corrupting cached content', () => {
  const send = contentResponse.create();
  const before = { text:longText, ansi:longText };
  const first = response(send, before);
  const truncation = { text:longText.slice(1000) + 'latest output', ansi:longText.slice(1000) + 'latest output' };
  const next = response(send, truncation, { base:first.headers.ETag });
  assert.deepEqual(merged(before, next), truncation);
  const rollover = { messages:[{ id:'new-source', text:'新会话内容' }], completed:null };
  const last = response(send, rollover, { base:next.headers.ETag });
  assert.equal(last.data.delta, undefined, 'A patch larger than the replacement is not worthwhile');
  assert.deepEqual(last.data, rollover);
});

test('unknown and weak baselines cannot produce patches, and a matching current ETag returns 304', () => {
  const send = contentResponse.create();
  const first = response(send, { text:longText });
  for (const base of ['"' + 'a'.repeat(64) + '"', 'W/' + first.headers.ETag, '*']) {
    assert.equal(response(send, { text:longText + base }, { base }).data.delta, undefined);
  }
  const unchanged = response(send, { text:longText }, { base:'W/"other", ' + first.headers.ETag });
  assert.equal(unchanged.code, 304);
});

test('baseline lookup is isolated across sessions, generations, views, routers and credentials', () => {
  const send = contentResponse.create(), before = { text:longText }, after = { text:longText + 'added' };
  const original = response(send, before, { scope:'one:generation1:answer', headers:{ authorization:'Basic first', cookie:'identity=one' } });
  const base = original.headers.ETag;
  for (const options of [
    { scope:'two:generation1:answer', headers:{ authorization:'Basic first', cookie:'identity=one' } },
    { scope:'one:generation2:answer', headers:{ authorization:'Basic first', cookie:'identity=one' } },
    { scope:'one:generation1:full', headers:{ authorization:'Basic first', cookie:'identity=one' } },
    { scope:'one:generation1:answer', headers:{ authorization:'Basic second', cookie:'identity=one' } },
    { scope:'one:generation1:answer', headers:{ authorization:'Basic first', cookie:'identity=two' } },
  ]) assert.equal(response(send, after, { ...options, base }).data.delta, undefined);
  assert.equal(response(contentResponse.create(), after, { scope:'one:generation1:answer', base,
    headers:{ authorization:'Basic first', cookie:'identity=one' } }).data.delta, undefined);
  assert.ok(response(send, after, { scope:'one:generation1:answer', base,
    headers:{ authorization:'Basic first', cookie:'identity=one' } }).data.delta);
});

test('delta revisions are bounded, expire, and oversized snapshots do not become baselines', () => {
  let clock = 1000;
  const send = contentResponse.create({ maxVersions:2, maxScopes:2, maxBytes:longText.length * 8, ttl:100, now:() => clock });
  const first = response(send, { text:longText });
  response(send, { text:longText + 'second' }); response(send, { text:longText + 'third' });
  assert.equal(response(send, { text:longText + 'fourth' }, { base:first.headers.ETag }).data.delta, undefined);
  const other = response(send, { text:longText }, { scope:'two' });
  response(send, { text:longText }, { scope:'three' });
  assert.equal(response(send, { text:longText + 'evicted' }, { base:first.headers.ETag }).data.delta, undefined);
  clock += 101;
  assert.equal(response(send, { text:longText + 'expired' }, { scope:'two', base:other.headers.ETag }).data.delta, undefined);
  const tiny = contentResponse.create({ maxBytes:100 });
  const tooBig = response(tiny, { text:longText });
  assert.equal(response(tiny, { text:longText + 'new' }, { base:tooBig.headers.ETag }).data.delta, undefined);
});

test('mobile answer, full and history routes negotiate independently and reject in-flight generation replacement', async t => {
  let generation = 'first', tail = '', release;
  const manager = { getSession:name => ({ name, createdAt:generation }),
    history:async name => ({ name, text:longText + tail, ansi:longText + tail }),
    mobile:async (name, full) => {
      if (tail === 'held') await new Promise(resolve => { release = resolve; });
      return full ? { text:longText + tail, ansi:longText + tail } : { messages:[{ id:'one', text:longText + tail }], completed:null };
    } };
  const app = express(); app.use('/api/sessions', sessionRoutes(manager));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api/sessions/one/`;
  const first = {};
  for (const route of ['mobile', 'mobile?view=full', 'history']) {
    const res = await fetch(origin + route); first[route] = { data:await res.json(), etag:res.headers.get('ETag') };
  }
  tail = 'new output';
  for (const route of Object.keys(first)) {
    const res = await fetch(origin + route, { headers:{ 'If-None-Match':first[route].etag, 'X-TTYD-Delta':'fields-v1' } });
    const data = await res.json();
    assert.ok(data.delta, `${route} supports opt-in incremental reads`);
    assert.deepEqual(merged(first[route].data, { data, headers:{ ETag:res.headers.get('ETag') } }),
      route === 'mobile' ? await manager.mobile('one', false) : route === 'history' ? await manager.history('one') : await manager.mobile('one', true));
  }
  generation = 'replacement';
  const replaced = await fetch(origin + 'mobile', { headers:{ 'If-None-Match':first.mobile.etag, 'X-TTYD-Delta':'fields-v1' } });
  assert.equal((await replaced.json()).delta, undefined);
  tail = 'held';
  const pending = fetch(origin + 'mobile');
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release); generation = 'replaced-while-reading'; release();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.match((await result.json()).error, /会话已更换/);
});

test('generation preconditions reject stale answer, full and history reads before work and after awaited capture', async t => {
  let generation = 'initial', suffix = '', calls = 0, hold = false, release, captured;
  const manager = { getSession:name => ({ name, createdAt:generation }),
    async read(name, full) {
      calls++;
      const data = full ? { text:longText + suffix, ansi:longText + suffix } :
        { messages:[{ id:name, text:longText + suffix }], completed:null };
      captured = data;
      if (hold) await new Promise(resolve => { release = resolve; });
      return data;
    }, history(name) { return this.read(name, true); }, mobile(name, full) { return this.read(name, full); } };
  const app = express(); app.use('/api/sessions', sessionRoutes(manager));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api/sessions/one/`;
  for (const route of ['mobile', 'mobile?view=full', 'history']) {
    generation = 'first-' + route; suffix = 'first';
    const headers = { 'X-TTYD-Generation':generation, 'X-TTYD-Delta':'fields-v1' };
    const first = await fetch(origin + route, { headers });
    assert.equal(first.status, 200);
    await first.json();
    const count = calls;
    // Even a valid content ETag must not bypass the identity precondition.
    const mismatch = await fetch(origin + route, { headers:{ ...headers,
      'X-TTYD-Generation':'wrong-generation', 'If-None-Match':first.headers.get('ETag') } });
    assert.equal(mismatch.status, 409);
    assert.doesNotMatch(mismatch.headers.get('ETag') || '', /^"[a-f0-9]{64}"$/, 'Errors cannot publish a content validator');
    assert.equal(mismatch.headers.get('Cache-Control'), 'no-store');
    assert.match((await mismatch.json()).error, /会话已更换/);
    assert.equal(calls, count, 'Stale generations must not initialize/capture a replacement session');
    generation = 'second-' + route;
    const replaced = await fetch(origin + route, { headers });
    assert.equal(replaced.status, 409);
    assert.equal(calls, count);
    await replaced.json();
    hold = true; release = null;
    const pending = fetch(origin + route, { headers:{ ...headers, 'X-TTYD-Generation':generation } });
    for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(release, `${route} reached the awaited capture`);
    const rejectedEtag = hash(serialized(captured));
    generation = 'third-' + route; hold = false; release();
    const changed = await pending;
    assert.equal(changed.status, 409);
    assert.doesNotMatch(changed.headers.get('ETag') || '', /^"[a-f0-9]{64}"$/);
    assert.match((await changed.json()).error, /会话已更换/);
    suffix = 'third';
    const current = await fetch(origin + route, { headers:{ ...headers,
      'X-TTYD-Generation':generation, 'If-None-Match':rejectedEtag } });
    assert.equal(current.status, 200);
    const currentBody = await current.json();
    assert.equal(currentBody.delta, undefined, 'Rejected captures cannot seed a delta baseline under a replacement identity');
    assert.match(serialized(currentBody), /third/);
    const legacy = await fetch(origin + route);
    assert.equal(legacy.status, 200, 'The generation header is optional for existing clients');
    await legacy.json();
  }
});

test('serialized field splices survive Unicode code-unit and JSON escape boundaries over repeated wire round trips', () => {
  const send = contentResponse.create();
  const tokens = ['🙂', '🙃', '中', 'e\u0301', '\u2028', '\n', '\r', '\t', '\\', '"', '\x1b[32m', '\ud800', '\udfff'];
  let seed = 9347;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  let before = { text:longText + tokens.join(''), ansi:longText + tokens.slice().reverse().join(''), count:0 };
  let baseline = response(send, before).headers.ETag;
  for (let i = 0; i < 100; i++) {
    const field = i % 2 ? 'ansi' : 'text', previous = before[field];
    // Include edits that split surrogate pairs or escape-adjacent boundaries;
    // JSON.stringify still produces valid JSON for isolated UTF-16 surrogates.
    const at = longText.length + random(previous.length - longText.length + 1);
    const after = { ...before, [field]:previous.slice(0, at) + tokens[random(tokens.length)] + previous.slice(at + random(3)), count:i + 1 };
    const next = response(send, after, { base:baseline });
    assert.ok(next.data.delta);
    next.data = JSON.parse(JSON.stringify(next.data));
    assert.deepEqual(merged(before, next), after);
    baseline = next.headers.ETag; before = after;
  }
  assert.equal(Object.prototype.polluted, undefined);
});
