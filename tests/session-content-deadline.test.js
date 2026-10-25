const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: pause, setImmediate: settle } = require('node:timers/promises');

async function outcomeWithin(promise, milliseconds = 150) {
  return Promise.race([
    promise.then(value => ({ value }), error => ({ error })),
    pause(milliseconds).then(() => ({ pending: true })),
  ]);
}
function shortDeadline(t, duration = 30) {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) =>
    original(callback, milliseconds === 15000 ? duration : milliseconds, ...args));
}

test('a fetch that ignores AbortSignal still times out and an ordinary read retries without an external event', async t => {
  shortDeadline(t);
  const cache = await import('../frontend/src/utils/session-content.mjs?deadline-headers');
  const session = { name: 'stalled-headers', createdAt: 'generation' };
  let requests = 0, signal, finishOld;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    if (++requests === 1) {
      signal = options.signal;
      return new Promise(resolve => { finishOld = resolve; });
    }
    return Promise.resolve(Response.json({ messages: [{ id: 'final', text: 'Completed answer' }], completed: 'done' }));
  });
  const first = cache.fetchContent(session, 'answer');
  const failed = await outcomeWithin(first);
  assert.equal(signal.aborted, true, 'The transport receives the cancellation request');
  assert.equal(failed.error?.name, 'AbortError', 'Cancellation must settle the application request even if the transport ignores it');
  const latest = await cache.fetchContent(session, 'answer'); // No fresh flag, input, focus or activity event.
  assert.equal(requests, 2, 'The expired pending job cannot swallow subsequent scheduled reads');
  assert.equal(latest.data.completed, 'done');
  finishOld(Response.json({ messages: [{ id: 'old', text: 'Incomplete old progress' }], completed: null }));
  await settle();
  assert.equal(cache.peekContent(session, 'answer'), latest, 'A late obsolete response cannot overwrite the final answer');
});

test('a JSON body that ignores AbortSignal cannot pin the answer cache after its deadline', async t => {
  shortDeadline(t);
  const cache = await import('../frontend/src/utils/session-content.mjs?deadline-body');
  const session = { name: 'stalled-body', createdAt: 'generation' };
  let requests = 0, signal, finishOldBody;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (++requests === 1) {
      signal = options.signal;
      return { ok: true, status: 200, headers: new Headers({ ETag: '"old"' }),
        json: () => new Promise(resolve => { finishOldBody = resolve; }) };
    }
    return Response.json({ messages: [{ id: 'final', text: 'Final body' }], completed: 'done' });
  });
  const failed = await outcomeWithin(cache.fetchContent(session, 'answer'));
  assert.equal(signal.aborted, true);
  assert.equal(failed.error?.name, 'AbortError', 'Waiting for response.json() is part of the bounded request');
  const latest = await cache.fetchContent(session, 'answer');
  assert.equal(requests, 2);
  finishOldBody({ messages: [{ id: 'old', text: 'Old delayed body' }], completed: null });
  await settle();
  assert.equal(cache.peekContent(session, 'answer'), latest);
  assert.equal(latest.data.completed, 'done');
});

test('replacement reads settle the superseded caller even when its fetch never acknowledges abort', async t => {
  shortDeadline(t, 1000);
  const cache = await import('../frontend/src/utils/session-content.mjs?replacement-hard-abort');
  const session = { name: 'replaced-stall', createdAt: 'generation' };
  let requests = 0, signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (++requests === 1) { signal = options.signal; return new Promise(() => {}); }
    return Response.json({ messages: [{ id: 'final', text: 'Fresh final reply' }], completed: 'done' });
  });
  const first = cache.fetchContent(session, 'answer');
  const failed = outcomeWithin(first);
  await settle();
  const latest = await cache.fetchContent(session, 'answer', { fresh: true });
  assert.equal(signal.aborted, true);
  assert.equal((await failed).error?.name, 'AbortError');
  assert.equal(requests, 2);
  assert.equal(cache.peekContent(session, 'answer'), latest);
});
