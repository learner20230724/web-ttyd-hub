const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: settle } = require('node:timers/promises');
const SessionSync = require('../server/services/session-sync');
const modules = Promise.all([
  import('../frontend/node_modules/pinia/dist/pinia.mjs'),
  import('../frontend/src/stores/sessions.js'),
]);
const metadataKey = 'web-ttyd-hub.session-metadata.v1', pendingKey = 'web-ttyd-hub.shared-pending.v1';
const createdAt = '2026-10-24T00:00:00Z';

async function fixture(t) {
  const [{ createPinia, disposePinia }, { useSessionStore }] = await modules;
  const sessions = ['a', 'b', 'c'].map(name => ({ name, createdAt, shell: 'codex', status: 'running',
    activity: { available: true, detected: true, phase: 'completed', busy: false, completed: `${name}:done` } }));
  const layout = { order: ['a', 'b', 'c'], pinned: [] };
  const local = new Map([
    ['web-ttyd-hub.shared-migrated.v1', '1'],
    [metadataKey, JSON.stringify({ version: 1, sessions, layout, read: {}, shells: [], platform: 'linux', selection: { name: 'a', createdAt } })],
  ]), tab = new Map();
  const storage = values => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
  const document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => false }), window = new EventTarget();
  const globals = { document, window, localStorage: storage(local), sessionStorage: storage(tab) };
  const originals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const manager = new EventEmitter(); manager.sessions = new Map(sessions.map(s => [s.name, s])); manager.list = () => [...manager.sessions.values()];
  manager.sync = new SessionSync(manager); manager.sync.restore({ revision: 1, read: {}, layout });
  let online = false;
  const mutations = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    assert(online, 'Cached interactions cannot submit before the authoritative list arrives');
    if (!options.method) { assert.equal(url, '/api/sessions'); return Response.json({ sessions: manager.list(), shared: manager.sync.snapshot() }); }
    assert.equal(url, '/api/sessions/sync');
    const op = JSON.parse(options.body); mutations.push(op);
    return Response.json(manager.sync.apply(op));
  });
  let pinia, store;
  const open = () => { pinia = createPinia(); store = useSessionStore(pinia); return store; };
  const close = () => { if (pinia) { disposePinia(pinia); pinia = null; } };
  t.after(async () => {
    close(); await settle();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return { open, close, mutations, manager,
    snapshot() { window.dispatchEvent(new Event('pagehide')); return JSON.parse(local.get(metadataKey)); },
    pending() { return JSON.parse(tab.get(pendingKey) || '[]'); },
    async connect() { online = true; await store.fetchSessions(); await settle(); await settle(); } };
}

test('cached pin and ordering intentions survive reload and merge after identity validation', async t => {
  const f = await fixture(t), first = f.open();
  assert.equal(first.cachedSnapshot, true);
  first.togglePin('b'); first.reorderSession('c', 'a', false);
  assert.equal(first.isPinned('b'), true, 'Cached operations are immediately visible');
  assert.deepEqual(first.sortedSessions.map(s => s.name), ['b', 'c', 'a']);
  assert.equal(f.mutations.length, 0);
  assert.deepEqual(f.pending().map(op => op.type), ['pin', 'move']);
  assert.deepEqual(f.snapshot().layout, { order: ['a', 'b', 'c'], pinned: [] }, 'Confirmed metadata stays separate from offline intentions');
  f.close();
  const reopened = f.open();
  assert.equal(reopened.isPinned('b'), true, 'Reload restores the durable pending pin over its cached preview');
  assert.deepEqual(reopened.sortedSessions.map(s => s.name), ['b', 'c', 'a']);
  await f.connect();
  assert.deepEqual(f.manager.sync.snapshot().layout, { order: ['b', 'c', 'a'], pinned: ['b'] });
  assert.deepEqual(f.pending(), []);
  assert.deepEqual(f.snapshot().layout, f.manager.sync.snapshot().layout);
  assert.deepEqual(f.mutations.map(op => op.type), ['pin', 'move']);
});

test('a cached pending pin cannot affect a recreated session with the same name', async t => {
  const f = await fixture(t), first = f.open();
  first.togglePin('b'); assert.equal(f.pending().length, 1);
  f.close();
  const reopened = f.open();
  const replacement = { ...f.manager.sessions.get('b'), createdAt: '2026-10-24T00:01:00Z' };
  f.manager.sessions.set('b', replacement);
  await f.connect();
  assert.equal(f.mutations[0].createdAt, createdAt, 'The queued intention keeps the original generation');
  assert.deepEqual(f.manager.sync.snapshot().layout.pinned, []);
  assert.equal(reopened.isPinned('b'), false);
  assert.deepEqual(f.pending(), []);
});
