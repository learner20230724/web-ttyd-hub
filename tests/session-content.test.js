const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../frontend/src/utils/session-content.mjs');

test('visible refreshes share one request and unchanged content retains its cached object', async t => {
  const { fetchContent } = await modulePromise;
  const session = { name: 'coalesced', createdAt: '2026-10-18' };
  let calls = 0, finish;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finish = () => resolve(Response.json({ messages: [], completed: null }, { headers: { ETag: '"one"' } })); });
    assert.equal(options.headers['If-None-Match'], '"one"');
    return new Response(null, { status: 304 });
  });
  const one = fetchContent(session, 'answer'), two = fetchContent(session, 'answer');
  await Promise.resolve(); finish();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(calls, 1); assert.equal(a, b);
  assert.equal(await fetchContent(session, 'answer'), a);
});

test('a synchronously rejected fetch cannot leave a permanently pending reading mode', async t => {
  const { fetchContent } = await modulePromise;
  const session = { name: 'retry-sync-error', createdAt: '2026-10-18' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    if (++calls === 1) throw Error('temporary fetch failure');
    return Promise.resolve(Response.json({ text: 'Recovered full view' }));
  });
  await assert.rejects(fetchContent(session, 'full'), /temporary fetch failure/);
  const recovered = await fetchContent(session, 'full');
  assert.equal(calls, 2); assert.equal(recovered.data.text, 'Recovered full view');
});
