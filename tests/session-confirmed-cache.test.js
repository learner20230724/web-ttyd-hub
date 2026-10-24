const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const modules = Promise.all([
  import('../frontend/node_modules/pinia/dist/pinia.mjs'),
  import('../frontend/node_modules/vue/index.mjs'),
  import('../frontend/src/stores/sessions.js'),
]);
const metadataKey = 'web-ttyd-hub.session-metadata.v1';
const createdAt = '2026-10-24T00:00:00Z';

async function fixture(t, mode = 'success') {
  const [{ createPinia, disposePinia }, { nextTick }, { useSessionStore }] = await modules;
  const values = new Map([['web-ttyd-hub.shared-migrated.v1', '1']]), outbox = new Map();
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  const document = Object.assign(new EventTarget(), { hidden: false, focused: false, hasFocus() { return this.focused; } });
  const window = new EventTarget();
  const globals = { localStorage: storage(values), sessionStorage: storage(outbox), document, window };
  const originals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const session = { name: 'confirmed-cache', createdAt, shell: 'codex', status: 'running',
    activity: { available: true, detected: true, phase: 'completed', busy: false, completed: 'turn-new' } };
  const originalShared = { revision: 1, read: { [session.name]: { createdAt, completed: 'turn-old' } }, layout: { order: [session.name], pinned: [] } };
  let shared = structuredClone(originalShared), stale = false, writes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!options.method) {
      assert.equal(url, '/api/sessions');
      return Response.json({ sessions: [session], shared: stale ? originalShared : shared });
    }
    assert.equal(url, '/api/sessions/sync');
    writes++;
    if (mode === 'pending') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('Synthetic disposed request')), { once: true }));
    if (mode === 'failed') return Response.json({ error: 'Synthetic unavailable synchronization' }, { status: 503 });
    const op = JSON.parse(options.body);
    shared = { ...shared, revision: shared.revision + 1 };
    if (op.type === 'read') shared.read = { ...shared.read, [session.name]: { createdAt, completed: op.completed } };
    else if (op.type === 'pin') shared.layout = { ...shared.layout, pinned: op.pinned ? [session.name] : [] };
    else assert.fail('Unexpected synthetic mutation');
    return Response.json({ accepted: true, shared });
  });
  const pinia = createPinia(), store = useSessionStore(pinia);
  store.setReadGuard(() => true);
  t.after(async () => {
    disposePinia(pinia); await settle();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  await store.fetchSessions(); store.select(session.name); await nextTick();
  const flush = async () => { await settle(); await settle(); };
  return { store, session, document, get shared() { return shared; }, get writes() { return writes; }, flush,
    staleList() { stale = true; },
    snapshot() { window.dispatchEvent(new Event('pagehide')); return JSON.parse(values.get(metadataKey)); } };
}

test('confirmed HTTP read and pin responses reach durable metadata even without a WebSocket notification', async t => {
  const f = await fixture(t);
  f.document.focused = true; f.store.markRead(); await f.flush();
  f.store.togglePin(f.session.name); await f.flush();
  assert.equal(f.writes, 2);
  assert.equal(f.shared.read[f.session.name].completed, 'turn-new');
  assert.equal(f.store.activityState(f.store.sessions[0]), 'idle');
  assert.equal(f.store.isPinned(f.session.name), true);
  const disk = f.snapshot();
  assert.equal(disk.read[f.session.name], 'turn-new', 'A confirmed read cannot be replaced by the older opening list in the local snapshot');
  assert.deepEqual(disk.layout.pinned, [f.session.name]);
});

for (const mode of ['pending', 'failed']) test(`${mode} synchronization cannot persist an optimistic pin as confirmed metadata`, async t => {
  const f = await fixture(t, mode);
  f.store.togglePin(f.session.name); await f.flush();
  assert.equal(f.store.isPinned(f.session.name), true, 'The visible optimistic interaction remains responsive');
  assert.deepEqual(f.snapshot().layout.pinned, [], 'A reopen cache must contain the latest confirmed server layout');
});

test('a delayed lower revision list cannot roll back a confirmed read or pin in durable metadata', async t => {
  const f = await fixture(t);
  f.document.focused = true; f.store.markRead(); await f.flush();
  f.store.togglePin(f.session.name); await f.flush();
  f.staleList(); await f.store.fetchSessions(); await f.flush();
  const disk = f.snapshot();
  assert.equal(disk.read[f.session.name], 'turn-new');
  assert.deepEqual(disk.layout.pinned, [f.session.name]);
});
