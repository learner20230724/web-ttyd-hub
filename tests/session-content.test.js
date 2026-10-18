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

test('missing dialogue and old terminal fallbacks cannot replace a cached Codex answer', async t => {
  const { fetchContent } = await modulePromise;
  const session = { name: 'answer-gap', createdAt: '2026-10-18', shell: 'codex' };
  const responses = [
    { messages: [{ id: 'one', text: 'Actual answer' }], completed: 'one' },
    { messages: [], answerUnavailable: true, completed: null },
    { text: 'Legacy terminal fallback', completed: 'two' },
    { messages: [{ id: 'two', text: 'Recovered answer' }], completed: 'two' },
  ];
  t.mock.method(globalThis, 'fetch', async () => Response.json(responses.shift()));
  const answer = await fetchContent(session, 'answer');
  assert.equal(await fetchContent(session, 'answer'), answer);
  assert.equal(await fetchContent(session, 'answer'), answer);
  assert.equal((await fetchContent(session, 'answer')).data.messages[0].text, 'Recovered answer');
});

test('a legacy terminal cached before Codex detection is not reused as an answer', async t => {
  const { fetchContent, peekContent, loadContent } = await modulePromise;
  const session = { name: 'detected-later', createdAt: '2026-10-18', shell: 'bash' };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ text: 'Legacy full terminal output' }));
  assert.equal((await fetchContent(session, 'answer')).data.text, 'Legacy full terminal output');
  session.activity = { detected: true, available: false };
  assert.equal(peekContent(session, 'answer'), null);
  assert.equal(await loadContent(session, 'answer'), null);
  const answer = await fetchContent(session, 'answer');
  assert.deepEqual(answer.data.messages, []);
  assert.equal(answer.data.text, undefined);
  assert.equal(answer.data.answerUnavailable, true);
  assert.equal(peekContent(session, 'answer'), null, 'An unavailable response must not overwrite the persistent answer cache');
  assert.equal((await fetchContent(session, 'full')).data.text, 'Legacy full terminal output');
});
