const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const modulePromise = import('../frontend/src/utils/session-sync.mjs');
const createdAt = '2026-10-14T00:00:00Z';
const initial = () => ({ revision: 0, read: {}, layout: { order: ['a', 'b'], pinned: [] } });
const marker = completed => ({ createdAt, completed });
const readOp = completed => ({ type: 'read', name: 'a', createdAt, completed });
const pendingKey = 'web-ttyd-hub.shared-pending.v1';
async function setup(t, legacy = {}) {
  const { createSessionSync } = await modulePromise;
  const local = new Map(legacy.migrate ? [] : [['web-ttyd-hub.shared-migrated.v1', '1']]), tab = new Map();
  const storage = values => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const [name, value] of Object.entries({ localStorage: storage(local), sessionStorage: storage(tab) })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  const sessions = ['a', 'b'].map(name => ({ name, createdAt, status: 'running', activity: { completed: 'turn-1' } }));
  const view = { value: null, error: '', refreshes: 0 };
  const open = () => {
    const sync = createSessionSync({ sessions: () => sessions, legacyRead: legacy.read || {}, legacyLayout: legacy.layout,
      apply: value => { view.value = value }, error: value => { view.error = value }, refresh: () => { view.refreshes++ } });
    t.after(() => sync.dispose()); return sync;
  };
  return { open, view, sessions, tab };
}

test('A delayed mutation response and old list cannot overwrite newer remote reads or pins', async t => {
  const f = await setup(t); let respond;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { respond = resolve }));
  const sync = f.open(); sync.receive(initial()); sync.enqueue(readOp('turn-1'));
  assert.equal(f.view.value.read.a, 'turn-1');
  const newer = { revision: 3, read: { a: marker('turn-1'), b: marker('turn-1') }, layout: { order: ['b', 'a'], pinned: ['b'] } };
  sync.receive(newer);
  respond(Response.json({ accepted: true, shared: { ...initial(), revision: 1, read: { a: marker('turn-1') } } })); await settle();
  sync.receive(initial());
  assert.deepEqual({ ...f.view.value.read }, { a: 'turn-1', b: 'turn-1' });
  assert.deepEqual(f.view.value.layout, newer.layout);
});

test('Failed receipts survive reload, retry, and never hide a newer completion', async t => {
  const f = await setup(t); let offline = true, requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; if (offline) throw Error('offline'); return Response.json({ accepted: false, shared: initial() }); });
  const sync = f.open(); sync.receive(initial()); sync.enqueue(readOp('turn-1')); await settle();
  assert.equal(JSON.parse(f.tab.get(pendingKey)).length, 1); assert.match(f.view.error, /尚未同步/);
  sync.dispose(); f.sessions[0].activity.completed = 'turn-2';
  const reopened = f.open(); reopened.receive(initial()); await settle();
  assert.equal(f.view.value.read.a, undefined);
  offline = false; reopened.receive(initial()); await settle();
  assert.equal(JSON.parse(f.tab.get(pendingKey)).length, 0); assert.equal(f.view.refreshes, 1); assert.equal(requests, 3);
});

test('Upgrade merges matching legacy reads, but never replaces an established server layout', async t => {
  const f = await setup(t, { migrate: true, read: { a: 'turn-1', b: 'old-turn' }, layout: { order: ['a'], pinned: ['a'] } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ accepted: true, shared: { ...initial(), revision: 1, read: { a: marker('turn-1') } } }); });
  f.open().receive(initial()); await settle();
  assert.deepEqual(requests, [readOp('turn-1')]);
  assert.deepEqual(f.view.value.layout, initial().layout);
});
