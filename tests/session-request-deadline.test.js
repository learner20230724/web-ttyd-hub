const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const modules = Promise.all([
  import('../frontend/node_modules/pinia/dist/pinia.mjs'),
  import('../frontend/src/stores/sessions.js'),
  import('../frontend/src/utils/session-sync.mjs'),
]);
const createdAt = '2026-10-25T00:00:00Z';
const pendingKey = 'web-ttyd-hub.shared-pending.v1';
const storage = values => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
function browserGlobals(t) {
  const local = new Map([['web-ttyd-hub.shared-migrated.v1', '1']]), tab = new Map();
  const document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => false });
  const globals = { document, window: new EventTarget(), localStorage: storage(local), sessionStorage: storage(tab),
    location: { protocol: 'http:', host: 'synthetic.test' }, WebSocket: class { close() {} } };
  const state = { tab, cleanup() {} };
  const originals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    state.cleanup();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return state;
}
function stalledResponse(stage, capture) {
  if (stage === 'headers') return new Promise(resolve => capture(response => resolve(Response.json(response))));
  return Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => capture(resolve)) });
}
const task = phase => ({ name: 'reader', createdAt, status: 'running', shell: 'codex',
  activity: { available: true, phase, busy: phase === 'working', completed: phase === 'completed' ? 'done' : null } });

for (const stage of ['headers', 'body']) test(`a stalled list ${stage} cannot block ordinary five-second reconciliation after its deadline`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const [{ createPinia, disposePinia }, { useSessionStore }] = await modules;
  const globals = browserGlobals(t);
  let lists = 0, late, signal;
  t.mock.method(globalThis, 'fetch', (url, options = {}) => {
    assert.equal(options.method, undefined, 'State recovery performs no input or shared-state write');
    if (url === '/api/sessions/shells') return Promise.resolve(Response.json({ platform: 'linux', shells: [] }));
    assert.equal(url, '/api/sessions');
    if (++lists === 1) { signal = options.signal; return stalledResponse(stage, resolve => { late = resolve; }); }
    return Promise.resolve(Response.json({ sessions: [task('completed')] }));
  });
  const pinia = createPinia(), store = useSessionStore(pinia);
  globals.cleanup = () => disposePinia(pinia);
  store.init(); await settle();
  t.mock.timers.tick(5000); await settle();
  assert.equal(lists, 1, 'The first ordinary tick shares the still-active request');
  t.mock.timers.tick(5000); await settle(); await settle();
  assert.equal(signal.aborted, true);
  assert.equal(lists, 2, 'After the actual deadline, the queued ordinary reconciliation must start another request');
  assert.equal(store.loaded, true);
  assert.equal(store.unreadCount, 1);
  assert.equal(store.sessions[0].activity.completed, 'done');
  late({ sessions: [task('working')] }); await settle();
  assert.equal(store.sessions[0].activity.completed, 'done', 'The ignored-abort response cannot roll a recovered list back');
  assert.equal(store.connectionIssue, false);
});

for (const stage of ['headers', 'body']) test(`a stalled sync ${stage} releases its queue while retaining the unconfirmed operation`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [, , { createSessionSync }] = await modules;
  const globals = browserGlobals(t), { tab } = globals;
  const sessions = [{ name: 'reader', createdAt, status: 'running', activity: { completed: 'done' } }];
  const initial = { revision: 0, read: {}, layout: { order: ['reader'], pinned: [] } };
  const accepted = { ...initial, revision: 1, read: { reader: { createdAt, completed: 'done' } } };
  let requests = 0, late, finishPin, signal, issue = '', confirmed;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    if (++requests === 1) { signal = options.signal; return stalledResponse(stage, resolve => { late = resolve; }); }
    if (requests === 3) return new Promise(resolve => { finishPin = resolve; });
    return Promise.resolve(Response.json({ accepted: true, shared: accepted }));
  });
  const sync = createSessionSync({ sessions: () => sessions, legacyRead: {}, legacyLayout: initial.layout,
    apply() {}, confirmed: value => { confirmed = value; }, error: value => { issue = value; }, refresh() {} });
  globals.cleanup = () => sync.dispose();
  sync.receive(initial); sync.enqueue({ type: 'read', name: 'reader', createdAt, completed: 'done' }); await settle();
  t.mock.timers.tick(10000); await settle();
  assert.equal(signal.aborted, true);
  assert.match(issue, /尚未同步/, 'A deadline cannot leave an unconfirmed operation permanently looking in flight');
  assert.equal(JSON.parse(tab.get(pendingKey)).length, 1);
  assert.equal(confirmed.revision, 0, 'An expired request did not confirm its optimistic state');
  t.mock.timers.tick(100000); await settle();
  assert.equal(requests, 1, 'The deadline does not introduce an automatic resend loop');
  sync.retry(); await settle();
  assert.equal(requests, 2);
  assert.deepEqual(JSON.parse(tab.get(pendingKey)), []);
  sync.enqueue({ type: 'pin', name: 'reader', createdAt, pinned: true }); await settle();
  late({ accepted: true, shared: { ...initial, revision: 99 } }); await settle();
  assert.equal(confirmed.revision, 1, 'A late expired result cannot confirm an unrelated state');
  assert.equal(JSON.parse(tab.get(pendingKey)).length, 1, 'A late result cannot consume the next pending pin');
  finishPin(Response.json({ accepted: true, shared: { ...accepted, revision: 2, layout: { order: ['reader'], pinned: ['reader'] } } }));
  await settle();
  assert.deepEqual(JSON.parse(tab.get(pendingKey)), []);
  assert.equal(confirmed.revision, 2);
  assert.equal(issue, '');
});
