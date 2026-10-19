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

test('a live terminal reply is not hidden behind an older structured answer', async t => {
  const { fetchContent } = await modulePromise;
  const session = { name: 'answer-gap', createdAt: '2026-10-18', shell: 'codex' };
  const responses = [
    { messages: [{ id: 'one', text: 'Actual answer' }], completed: 'one' },
    { text: 'New final reply from the live terminal', completed: 'two' },
    { messages: [{ id: 'two', text: 'Recovered answer' }], completed: 'two' },
  ];
  t.mock.method(globalThis, 'fetch', async () => Response.json(responses.shift()));
  assert.equal((await fetchContent(session, 'answer')).data.messages[0].text, 'Actual answer');
  assert.equal((await fetchContent(session, 'answer')).data.text, 'New final reply from the live terminal');
  assert.equal((await fetchContent(session, 'answer')).data.messages[0].text, 'Recovered answer');
});

test('detecting Codex cannot discard readable output already cached on the phone', async t => {
  const { fetchContent, peekContent, loadContent } = await modulePromise;
  const session = { name: 'detected-later', createdAt: '2026-10-18', shell: 'bash' };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ text: 'Legacy full terminal output' }));
  assert.equal((await fetchContent(session, 'answer')).data.text, 'Legacy full terminal output');
  session.activity = { detected: true, available: false };
  assert.equal(peekContent(session, 'answer').data.text, 'Legacy full terminal output');
  assert.equal((await loadContent(session, 'answer')).data.text, 'Legacy full terminal output');
  const answer = await fetchContent(session, 'answer');
  assert.equal(answer.data.text, 'Legacy full terminal output');
  assert.equal((await fetchContent(session, 'full')).data.text, 'Legacy full terminal output');
});

test('foreground refresh replaces a suspended request and a late response cannot overwrite the final reply', async t => {
  const { fetchContent, peekContent } = await modulePromise;
  const session = { name: 'suspended-request', createdAt: '2026-10-19', shell: 'codex' };
  let finishOld, oldSignal, calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    if (++calls === 1) {
      oldSignal = signal;
      // Simulate a WebView transport that does not settle promptly on abort.
      return new Promise(resolve => { finishOld = () => resolve(Response.json({ messages: [{ text: 'Old progress' }] })); });
    }
    return Response.json({ messages: [{ text: 'Final answer' }], completed: 'done' });
  });
  const old = fetchContent(session, 'answer');
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await Promise.resolve();
  const fresh = await fetchContent(session, 'answer', { fresh: true });
  assert.equal(oldSignal.aborted, true);
  assert.equal(fresh.data.messages[0].text, 'Final answer');
  finishOld(); await rejected;
  assert.equal(peekContent(session, 'answer'), fresh);
});
