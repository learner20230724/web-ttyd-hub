const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const response = require('../server/services/content-response');
const client = import('../frontend/src/utils/content-delta.mjs');
const hash = data => '"' + createHash('sha256').update(JSON.stringify(data)).digest('hex') + '"';
function serverPatch(before, after) {
  const send = response.create();
  const res = () => ({ headers: {}, set(k, v) { this.headers[k] = v; }, json(data) { this.data = data; }, status() { return this; }, end() {} });
  send({ headers: {} }, res(), before, 'test');
  const result = res();
  send({ headers: { 'x-ttyd-delta': 'fields-v1', 'if-none-match': hash(before) } }, result, after, 'test');
  assert(result.data.delta);
  return result.data.delta;
}

test('HTTP-safe client SHA256 agrees with server for Unicode, escapes and lone surrogates', async () => {
  const { contentETag } = await client;
  for (const text of ['', '中文🙂🙃\uD800\n\x1b[32m\\"', 'x'.repeat(250000)]) {
    const value = { messages: [{ text }], completed: null };
    assert.equal(contentETag(value), hash(value));
  }
});

test('actual server field deltas reconstruct exact content order and dangerous own keys', async () => {
  const { applyContentDelta } = await client;
  const before = JSON.parse('{"__proto__":{"secret":"safe"},"text":"' + '缓存'.repeat(8000) + '","gone":true,"constructor":1}');
  const after = JSON.parse('{"constructor":2,"text":"' + '缓存'.repeat(8000) + '🙃\\n\\u001b[32m完成","__proto__":{"secret":"still safe"},"toString":false}');
  const delta = JSON.parse(JSON.stringify(serverPatch(before, after)));
  const result = applyContentDelta({ data: before, etag: hash(before) }, delta, hash(after));
  assert.equal(JSON.stringify(result), JSON.stringify(after));
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal({}.secret, undefined);
  assert.throws(() => applyContentDelta({ data: before, etag: '"different"' }, delta, hash(after)));
  const broken = structuredClone(delta); broken.set.constructor = 99;
  assert.throws(() => applyContentDelta({ data: before, etag: hash(before) }, broken, hash(after)), /checksum/);
  const duplicate = structuredClone(delta); duplicate.keys.push(duplicate.keys[0]);
  assert.throws(() => applyContentDelta({ data: before, etag: hash(before) }, duplicate, hash(after)));
});

test('corrupt delta retries once without a baseline and never poisons durable content', async t => {
  const { fetchContent, peekContent } = await import('../frontend/src/utils/session-content.mjs?delta-recovery');
  const session = { name: 'recovery', createdAt: 'generation' };
  const before = { text: 'history'.repeat(5000), completed: null }, after = { ...before, text: before.text + '🙂完成', completed: 'done' };
  const bad = serverPatch(before, after); bad.etag = '"bad"';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { headers }) => {
    assert.equal(headers['X-TTYD-Generation'], 'generation');
    if (++calls === 1) return Response.json(before, { headers: { ETag: hash(before) } });
    if (calls === 2) {
      assert.equal(headers['X-TTYD-Delta'], 'fields-v1');
      assert.equal(headers['If-None-Match'], hash(before));
      return Response.json({ delta: bad }, { headers: { ETag: hash(after) } });
    }
    assert.equal(headers['If-None-Match'], undefined);
    assert.equal(headers['X-TTYD-Delta'], undefined);
    return Response.json(after, { headers: { ETag: hash(after) } });
  });
  await fetchContent(session, 'full');
  const result = await fetchContent(session, 'full');
  assert.equal(calls, 3); assert.deepEqual(result.data, after);
  assert.equal(peekContent(session, 'full'), result);
});

test('cold disk ETag avoids full redownload, but a blocked database has a bounded network delay', async t => {
  const session = { name: 'disk', createdAt: 'generation' };
  const key = JSON.stringify([session.name, session.createdAt, 'full']);
  const entry = { key, sessionId: session.name, generation: session.createdAt, data: { text: 'Durable local history' }, etag: '"disk-etag"', used: 1, bytes: 128 };
  const db = { transaction() { return { objectStore() { return { get() { const req = {}; setTimeout(() => req.onsuccess(), 10); Object.defineProperty(req, 'result', { get: () => entry }); return req; } }; } }; } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else delete globalThis.indexedDB; });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true,
    value: { open() { const req = {}; setTimeout(() => { req.result = db; req.onsuccess(); }, 5); return req; } } });
  t.mock.method(globalThis, 'fetch', async (_url, { headers }) => {
    assert.equal(headers['If-None-Match'], entry.etag);
    return new Response(null, { status: 304 });
  });
  const cold = await import('../frontend/src/utils/session-content.mjs?disk-conditional');
  assert.deepEqual((await cold.fetchContent(session, 'full')).data, entry.data);
  globalThis.indexedDB = { open() { return {}; } };
  let networkAt;
  t.mock.method(globalThis, 'fetch', async () => { networkAt = Date.now(); return Response.json({ text: 'Live despite blocked storage' }); });
  const stalled = await import('../frontend/src/utils/session-content.mjs?disk-blocked');
  const started = Date.now();
  assert.equal((await stalled.fetchContent(session, 'full')).data.text, 'Live despite blocked storage');
  assert(networkAt - started < 300, 'Storage must not stall a live request until its own timeout');
});
