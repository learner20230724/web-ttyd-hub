const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const activity = import('../frontend/src/utils/activity.mjs');
const client = import('../frontend/src/utils/session-sync.mjs');
const storeModules = Promise.all([import('../frontend/node_modules/pinia/dist/pinia.mjs'), import('../frontend/src/stores/sessions.js')]);
const createdAt = '2026-10-25T00:00:00Z', metadataKey = 'web-ttyd-hub.session-metadata.v1';
const session = revision => ({ name: 'target', createdAt, shell: 'codex', status: 'running',
  activity: { available: true, phase: 'completed', busy: false, completed: 't2', contentRevision: revision } });
const shared = revision => ({ revision: 1, read: { target: { createdAt, completed: 't2', contentRevision: revision } },
  layout: { order: ['target'], pinned: [] } });

function globals(t, initial = {}) {
  const local = new Map([['web-ttyd-hub.shared-migrated.v1', '1'], ...Object.entries(initial)]), tab = new Map();
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  const document = Object.assign(new EventTarget(), { hidden: false, focused: false, hasFocus() { return this.focused; } });
  const window = new EventTarget();
  const values = { localStorage: storage(local), sessionStorage: storage(tab), document, window };
  const descriptors = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const cleanup = [];
  t.after(() => {
    for (const dispose of cleanup) dispose();
    for (const [key, value] of Object.entries(descriptors)) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; }
  });
  return { local, tab, document, window, cleanup };
}

test('same completed turn with a newer answer revision is unread, while old unversioned history remains compatible', async () => {
  const { activityState, activityPresentation } = await activity;
  assert.equal(activityState(session('r1'), { target: 't2' }, { target: 'r1' }), 'idle');
  assert.equal(activityState(session('r2'), { target: 't2' }, { target: 'r1' }), 'unread');
  assert.equal(activityPresentation(session('r2'), { target: 't2' }, false, { target: 'r1' }).label, '已完成 · 未读');
  assert.equal(activityState(session('r2'), { target: 't2' }), 'idle', 'An old persistent marker without a revision must not make every historical turn green');
  const legacy = session(); delete legacy.activity.contentRevision;
  assert.equal(activityState(legacy, { target: 't2' }, { target: 'r1' }), 'idle');
  assert.equal(activityState(session('r2'), { target: 'older-turn' }, {}), 'unread');
});

for (const queuedRevision of [undefined, 'r1']) test(`an obsolete ${queuedRevision || 'unversioned'} queued read cannot clear or submit a later answer revision`, async t => {
  const g = globals(t), sessions = [session('r2')], { createSessionSync } = await client;
  const old = { type: 'read', name: 'target', createdAt, completed: 't2', ...(queuedRevision ? { contentRevision: queuedRevision } : {}) };
  g.tab.set('web-ttyd-hub.shared-pending.v1', JSON.stringify([old]));
  let visible, posts = 0;
  t.mock.method(globalThis, 'fetch', async () => { posts++; throw Error('A stale read must not be posted'); });
  const sync = createSessionSync({ sessions: () => sessions, legacyRead: {}, legacyLayout: {},
    apply: value => { visible = value; }, error() {}, refresh() {} });
  g.cleanup.push(() => sync.dispose());
  sync.receive(shared('r1')); await settle();
  assert.equal(visible.read.target, 't2'); assert.equal(visible.readRevisions.target, 'r1');
  assert.equal((await activity).activityState(sessions[0], visible.read, visible.readRevisions), 'unread');
  assert.equal(posts, 0);
  assert.deepEqual(JSON.parse(g.tab.get('web-ttyd-hub.shared-pending.v1')), []);
});

test('legacy migration never invents the current revision for an old local completed marker', async t => {
  const g = globals(t), { createSessionSync } = await client;
  g.local.delete('web-ttyd-hub.shared-migrated.v1');
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { posts.push(JSON.parse(options.body)); return Response.json({ accepted: true, shared: shared('r2') }); });
  const sync = createSessionSync({ sessions: () => [session('r2')], legacyRead: { target: 't2' }, legacyLayout: {},
    apply() {}, error() {}, refresh() {} });
  g.cleanup.push(() => sync.dispose()); sync.receive({ ...shared('r1'), read: {} }); await settle();
  assert.deepEqual(posts, [], 'An unversioned local history entry is not proof that newly discovered r2 was read');
});

test('a legacy read gains a revision only after actual rendering so later same-turn final content remains unread', async t => {
  const g = globals(t), [{ createPinia, disposePinia }, { useSessionStore }] = await storeModules;
  let target = session('r1'), state = shared(); delete state.read.target.contentRevision;
  const other = { name: 'other', createdAt, shell: 'bash', status: 'running', activity: { available: true, phase: 'idle' } };
  state.layout.order = ['other', 'target'];
  const mutations = [];
  t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    if (!options.method) return Response.json({ sessions: [target, other], shared: state });
    const op = JSON.parse(options.body); mutations.push(op);
    state = { ...state, revision: state.revision + 1, read: { target: { createdAt, completed: op.completed, contentRevision: op.contentRevision } } };
    return Response.json({ accepted: true, shared: state });
  });
  const pinia = createPinia(), store = useSessionStore(pinia);
  g.cleanup.push(() => disposePinia(pinia));
  let rendered = false;
  store.setReadGuard(() => rendered); await store.fetchSessions();
  assert.equal(store.activityState(store.sessions[0]), 'idle', 'The upgrade itself must not mark old history unread');
  g.document.focused = true; store.select('target'); await settle();
  assert.equal(mutations.length, 0, 'Merely selecting an unrendered old history must not stamp a revision');
  rendered = true;
  for (const activity of [{ phase: 'waiting' }, { phase: 'error' }, { phase: 'interrupted' }, { phase: 'unknown' },
    { busy: true }, { available: false }, { error: true }]) {
    target = session('r1'); target.activity = { ...target.activity, ...activity }; await store.fetchSessions(); store.markRead(); await settle();
    assert.equal(mutations.length, 0, `A rendered legacy marker cannot bypass activity gating: ${JSON.stringify(activity)}`);
  }
  target = { ...session('r1'), status: 'stopped' }; await store.fetchSessions(); store.markRead(); await settle();
  assert.equal(mutations.length, 0, 'A stopped session cannot acknowledge its old completion');
  target = session('r1'); await store.fetchSessions(); store.markRead();
  assert.deepEqual(store.sortedSessions.map(value => value.name), ['other', 'target'], 'Binding a rendered legacy version must not optimistically change manual order');
  await settle(); await settle();
  assert.equal(mutations.length, 1, 'The rendered current r1 must replace the legacy wildcard with a precise read');
  assert.equal(mutations[0].contentRevision, 'r1');
  rendered = false; target = session('r2'); await store.fetchSessions();
  assert.equal(store.activityState(store.sessions[0]), 'unread', 'A later same-turn final must no longer be hidden by the old wildcard');
});

test('background same-turn updates remain unread until current content is rendered, then persist across reopen', async t => {
  const g = globals(t), [{ createPinia, disposePinia }, { useSessionStore }] = await storeModules;
  let target = session('r1'), state = shared('r1'); const mutations = [];
  t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    if (!options.method) return Response.json({ sessions: [target], shared: state });
    const op = JSON.parse(options.body); mutations.push(op);
    state = { ...state, revision: state.revision + 1, read: { target: { createdAt, completed: op.completed, contentRevision: op.contentRevision } } };
    return Response.json({ accepted: true, shared: state });
  });
  let pinia = createPinia(), store = useSessionStore(pinia), displayed = 'r1';
  g.cleanup.push(() => { if (pinia) disposePinia(pinia); });
  store.setReadGuard(selected => selected.activity.contentRevision === displayed);
  await store.fetchSessions();
  assert.equal(store.unreadCount, 0);
  target = session('r2'); await store.fetchSessions();
  assert.equal(store.unreadCount, 1, 'A late final answer must become unread even when its completed token is unchanged');
  assert.equal(store.activityStatus(store.sessions[0]).label, '已完成 · 未读');
  g.document.focused = true; store.select('target'); store.markRead(); await settle();
  assert.equal(mutations.length, 0, 'Old r1 on screen cannot acknowledge r2');
  displayed = 'r2'; store.markRead(); await settle(); await settle();
  assert.equal(mutations.length, 1); assert.equal(mutations[0].contentRevision, 'r2');
  assert.equal(store.activityState(store.sessions[0]), 'idle');
  g.window.dispatchEvent(new Event('pagehide'));
  const disk = JSON.parse(g.local.get(metadataKey));
  assert.equal(disk.read.target, 't2'); assert.equal(disk.readRevisions.target, 'r2');
  disposePinia(pinia); pinia = createPinia(); g.document.focused = false; store = useSessionStore(pinia);
  assert.equal(store.cachedSnapshot, true); assert.equal(store.readRevisions.target, 'r2');
  await store.fetchSessions(); assert.equal(store.activityState(store.sessions[0]), 'idle');
});
