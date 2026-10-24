const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');

function diskFixture(t, session, data, delay = 250) {
  const key = JSON.stringify([session.name, session.createdAt, 'answer']);
  const original = { key, sessionId: session.name, generation: session.createdAt,
    data, etag: '"disk-structured"', bytes: JSON.stringify(data).length * 2, used: 1 };
  const rows = new Map([[key, original]]), metadata = new Map();
  const store = name => ({
    get(key) {
      // Capture when the request starts; delay only delivery of its result.
      const request = { result: structuredClone(rows.get(key)) };
      setTimeout(() => request.onsuccess?.(), delay);
      return request;
    },
    put(entry) { (name === 'content' ? rows : metadata).set(entry.key, structuredClone(entry)); },
    delete(key) { (name === 'content' ? rows : metadata).delete(key); },
    getAll() {
      const request = { result: [...(name === 'content' ? rows : metadata).values()].map(entry => structuredClone(entry)) };
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    },
  });
  const db = { transaction() { return { objectStore: store }; }, close() {} };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true,
    value: { open() { const request = { result: db }; setTimeout(() => request.onsuccess?.(), 0); return request; } } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else delete globalThis.indexedDB; });
  return { rows, key };
}

test('a fast terminal fallback retains a late structured disk answer without replacing the latest data or ETag', async t => {
  const session = { name: 'answer-disk-race', createdAt: 'generation' };
  const answer = { messages: [{ id: 'old', role: 'assistant', text: 'Previously verified answer' }], completed: 'old-turn' };
  const fallback = { text: 'New live terminal reply', completed: 'new-turn' };
  const disk = diskFixture(t, session, answer);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { headers }) => {
    if (++requests === 1) return Response.json(fallback, { headers: { ETag: '"live-fallback"' } });
    assert.equal(headers['If-None-Match'], '"live-fallback"');
    return new Response(null, { status: 304 });
  });
  const cache = await import('../frontend/src/utils/session-content.mjs?late-answer-race');
  const loading = cache.loadContent(session, 'answer');
  const latest = await cache.fetchContent(session, 'answer');
  assert.deepEqual(latest.data, fallback, 'The live terminal response remains the newest response');
  const merged = await loading;
  assert.equal(merged, latest);
  assert.deepEqual(merged.retainedAnswer, answer, 'A slower disk read must preserve its previously verified dialogue');
  assert.deepEqual(merged.data, fallback);
  assert.equal(merged.etag, '"live-fallback"');
  assert.equal(merged.bytes, (JSON.stringify(fallback).length + JSON.stringify(answer).length) * 2,
    'The retained copy participates in both memory and disk limits');
  assert.equal(await cache.fetchContent(session, 'answer'), merged, 'A 304 keeps the merged cache entry and retained answer');
  await settle();
  assert.deepEqual(disk.rows.get(disk.key).retainedAnswer, answer);
  // A new module has no memory cache, simulating another page process reopening.
  const reopened = await import('../frontend/src/utils/session-content.mjs?reopened-retained-answer');
  const restored = await reopened.loadContent(session, 'answer');
  assert.deepEqual(restored.data, fallback);
  assert.deepEqual(restored.retainedAnswer, answer);
  assert.equal(restored.etag, '"live-fallback"');
});

test('a new verified answer, including an empty message array, supersedes every retained older answer', async t => {
  const { saveContent, fetchContent } = await import('../frontend/src/utils/session-content.mjs?new-verified-answer');
  const session = { name: 'replace-answer', createdAt: 'generation' };
  const old = { messages: [{ id: 'old', text: 'Old answer' }], completed: 'old' };
  const fresh = { messages: [{ id: 'new', text: 'New answer' }], completed: 'new' };
  saveContent(session, 'answer', old);
  let fallback = saveContent(session, 'answer', { text: 'Live fallback', completed: 'new' }, '"fallback"');
  assert.deepEqual(fallback.retainedAnswer, old);
  let next = fresh;
  t.mock.method(globalThis, 'fetch', async () => Response.json(next));
  let verified = await fetchContent(session, 'answer');
  assert.deepEqual(verified.data, fresh); assert.equal(verified.retainedAnswer, undefined);
  fallback = saveContent(session, 'answer', { text: 'Another fallback' });
  assert.deepEqual(fallback.retainedAnswer, fresh);
  next = { messages: [], completed: null };
  verified = await fetchContent(session, 'answer');
  assert.deepEqual(verified.data.messages, []); assert.equal(verified.retainedAnswer, undefined);
  fallback = saveContent(session, 'answer', { text: 'Only a welcome screen' });
  assert.deepEqual(fallback.retainedAnswer.messages, [], 'A genuine empty conversation must never resurrect an older reply');
});

test('a late disk answer cannot revive old messages after a newer empty structured response', async t => {
  const session = { name: 'empty-wins-disk', createdAt: 'generation' };
  const old = { messages: [{ id: 'old', text: 'Obsolete answer' }], completed: 'old' };
  diskFixture(t, session, old);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ messages: [], completed: null }, { headers: { ETag: '"new-empty"' } }));
  const cache = await import('../frontend/src/utils/session-content.mjs?empty-wins-late-disk');
  const loading = cache.loadContent(session, 'answer');
  const latest = await cache.fetchContent(session, 'answer');
  assert.equal(await loading, latest);
  assert.deepEqual(latest.data.messages, []);
  assert.equal(latest.retainedAnswer, undefined);
});

test('answer retention cannot cross a session generation or leak into full and terminal cache views', async () => {
  const { saveContent } = await import('../frontend/src/utils/session-content.mjs?retention-isolation');
  const original = { name: 'same-name', createdAt: 'old-generation' };
  saveContent(original, 'answer', { messages: [{ id: 'old', text: 'Old generation private reply' }] });
  assert.equal(saveContent({ ...original, createdAt: 'new-generation' }, 'answer', { text: 'New session' }).retainedAnswer, undefined);
  assert.equal(saveContent(original, 'full', { text: 'Full terminal' }).retainedAnswer, undefined);
  assert.equal(saveContent(original, 'terminal', { version: 1, snapshot: {}, updates: [] }).retainedAnswer, undefined);
});
