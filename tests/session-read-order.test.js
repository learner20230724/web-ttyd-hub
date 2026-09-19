const { test } = require('node:test');
const assert = require('node:assert/strict');
const modules = Promise.all([
  import('../frontend/node_modules/pinia/dist/pinia.mjs'),
  import('../frontend/node_modules/vue/index.mjs'),
  import('../frontend/src/stores/sessions.js'),
]);
const layoutKey = 'web-ttyd-hub.session-layout.v1';
const readKey = 'web-ttyd-hub.read.v1';
const selectionKey = 'web-ttyd-hub.last-session.v1';

async function setup(t, initialLayout, initialRead = {}, initialSelection) {
  const [{ createPinia, disposePinia }, { nextTick }, { useSessionStore }] = await modules;
  const saved = new Map([[layoutKey, JSON.stringify(initialLayout)], [readKey, JSON.stringify(initialRead)]]);
  if (initialSelection) saved.set(selectionKey, JSON.stringify(initialSelection));
  const doc = Object.assign(new EventTarget(), { hidden: false, focused: true, hasFocus() { return this.focused; } });
  const win = new EventTarget();
  const globals = { document: doc, window: win, localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } };
  const originals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const pinia = createPinia();
  const store = useSessionStore(pinia);
  t.after(() => {
    disposePinia(pinia);
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { store, saved, doc, win, nextTick, order: () => store.sortedSessions.map(s => s.name),
    update: async sessions => { store.sessions = structuredClone(sessions); await nextTick(); } };
}
const session = (name, activity = {}) => ({ name, status: 'running', activity });

test('Reading green sessions moves each to the top of gray, preserves other groups, and saves the result', async t => {
  const layout = { order: ['gray-1', 'gray-2', 'busy', 'green-1', 'green-2'], pinned: [] };
  const f = await setup(t, layout);
  const sessions = [session('gray-1'), session('gray-2'), session('busy', { busy: true }),
    session('green-1', { completed: 'turn-1' }), session('green-2', { completed: 'turn-2' })];
  await f.update(sessions);
  assert.deepEqual(f.order(), ['green-1', 'green-2', 'busy', 'gray-1', 'gray-2']);
  f.store.select('green-1'); await f.nextTick();
  assert.deepEqual(f.order(), ['green-2', 'busy', 'green-1', 'gray-1', 'gray-2']);
  assert.equal(f.store.activityState(f.store.sessions.find(s => s.name === 'green-1')), 'idle');
  assert.equal(f.store.current, 'green-1');
  f.store.select('green-2'); await f.nextTick();
  assert.deepEqual(f.order(), ['busy', 'green-2', 'green-1', 'gray-1', 'gray-2']);
  assert.equal(JSON.parse(f.saved.get(readKey))['green-2'], 'turn-2');
  assert.equal(JSON.parse(f.saved.get(layoutKey)).order[0], 'green-2');

  // Refreshes, focusing, and clicking an already gray item must not undo dragging.
  f.store.reorderSession('green-2', 'gray-2', true);
  const manual = f.order();
  await f.update(sessions);
  f.win.dispatchEvent(new Event('focus'));
  f.store.select('gray-1'); await f.nextTick();
  f.store.select('green-2'); await f.nextTick();
  assert.deepEqual(f.order(), manual);
  assert.equal(manual.at(-1), 'green-2');
});

test('Busy stays busy when clicked; foreground completion promotes once, background completion stays unread', async t => {
  const f = await setup(t, { order: ['gray', 'worker'], pinned: [] });
  const sessions = [session('gray'), session('worker', { busy: true, completed: 'older-turn' })];
  await f.update(sessions);
  f.store.select('worker'); await f.nextTick();
  assert.equal(f.store.activityState(f.store.sessions[1]), 'busy');
  assert.deepEqual(JSON.parse(f.saved.get(readKey)), {});
  assert.deepEqual(JSON.parse(f.saved.get(layoutKey)).order, ['gray', 'worker']);
  sessions[1].activity = { busy: false, completed: 'new-turn' };
  await f.update(sessions);
  assert.deepEqual(f.order(), ['worker', 'gray']);
  assert.equal(f.store.activityState(f.store.sessions[1]), 'idle');

  f.doc.hidden = true;
  sessions[1].activity.completed = 'background-turn';
  await f.update(sessions);
  assert.equal(f.store.activityState(f.store.sessions[1]), 'unread');
  f.doc.hidden = false;
  f.doc.focused = false;
  f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.store.activityState(f.store.sessions[1]), 'unread');
  f.doc.focused = true;
  f.win.dispatchEvent(new Event('focus'));
  assert.equal(f.store.activityState(f.store.sessions[1]), 'idle');
  assert.equal(JSON.parse(f.saved.get(readKey)).worker, 'background-turn');
});

test('Pinned and regular gray groups stay separate; stopped and archived sessions are not promoted', async t => {
  const f = await setup(t, { order: ['p-gray', 'gray', 'p-green', 'green', 'stopped', 'archived'], pinned: ['p-gray', 'p-green'] });
  await f.update([session('p-gray'), session('gray'), session('p-green', { completed: 'p-turn' }),
    session('green', { completed: 'turn' }), { ...session('stopped', { busy: true, completed: 'old' }), status: 'stopped' },
    { ...session('archived', { completed: 'archive-turn' }), archivedAt: '2026-09-20T00:00:00Z' }]);
  f.store.select('green'); await f.nextTick();
  assert.deepEqual(f.order(), ['p-green', 'p-gray', 'green', 'gray', 'stopped']);
  f.store.select('p-green'); await f.nextTick();
  assert.deepEqual(f.order(), ['p-green', 'p-gray', 'green', 'gray', 'stopped']);
  assert.equal(f.store.activityState(f.store.sessions[2]), 'idle');
  const savedLayout = f.saved.get(layoutKey);
  f.store.select('stopped'); await f.nextTick();
  f.store.select('archived'); await f.nextTick();
  assert.equal(f.saved.get(layoutKey), savedLayout);
  assert.equal(f.store.activityState(f.store.sessions[4]), 'idle');
});

test('Saved read state and promoted gray order survive reopening the store', async t => {
  const f = await setup(t, { order: ['read', 'gray', 'busy', 'green'], pinned: [] }, { read: 'seen-turn' });
  await f.update([session('gray'), session('read', { completed: 'seen-turn' }),
    session('green', { completed: 'unseen-turn' }), session('busy', { busy: true })]);
  assert.deepEqual(f.order(), ['green', 'busy', 'read', 'gray']);
  assert.equal(f.store.activityState(f.store.sessions[1]), 'idle');
});

test('Last selection restores after a successful list, survives rename, and later refreshes do not switch tabs', async t => {
  const remembered = { name: 'return-here', createdAt: '2026-09-20T01:00:00Z' };
  const f = await setup(t, { order: [], pinned: [] }, {}, remembered);
  const sessions = [{ ...session(remembered.name), ...remembered, displayName: '已更名' }, session('other')];
  let respond;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { respond = resolve; }));
  const loading = f.store.fetchSessions();
  assert.equal(f.store.current, null);
  assert.equal(f.store.loaded, false);
  respond(Response.json({ sessions })); await loading; await f.nextTick();
  assert.equal(f.store.current, remembered.name);
  assert.equal(f.store.loaded, true);
  f.store.select('other');
  assert.deepEqual(JSON.parse(f.saved.get(selectionKey)), { name: 'other', createdAt: null });
  // A different tab's last selection applies only on the next open.
  f.saved.set(selectionKey, JSON.stringify(remembered));
  const refresh = f.store.fetchSessions(); respond(Response.json({ sessions })); await refresh;
  assert.equal(f.store.current, 'other');
});

test('Failed or malformed initial list does not erase the remembered session', async t => {
  const remembered = { name: 'saved', createdAt: null };
  const f = await setup(t, { order: [], pinned: [] }, {}, remembered);
  let response = Response.json({ sessions: [] }, { status: 401 });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(f.store.fetchSessions());
  assert.deepEqual(JSON.parse(f.saved.get(selectionKey)), remembered);
  response = Response.json({ sessions: null });
  await assert.rejects(f.store.fetchSessions());
  assert.equal(f.store.loaded, false);
  assert.deepEqual(JSON.parse(f.saved.get(selectionKey)), remembered);
  response = Response.json({ sessions: [session('saved')] });
  await f.store.fetchSessions();
  assert.equal(f.store.current, 'saved');
});

test('Deleted, archived and recreated sessions are not restored; stopped sessions are selected without starting', async t => {
  const remembered = { name: 'saved', createdAt: '2026-09-20T01:00:00Z' };
  for (const [label, sessions, expected] of [
    ['deleted', [], null],
    ['archived', [{ ...session('saved'), ...remembered, archivedAt: 'now' }], null],
    ['recreated', [{ ...session('saved'), createdAt: '2026-09-20T02:00:00Z' }], null],
    ['stopped', [{ ...session('saved'), ...remembered, status: 'stopped' }], 'saved'],
  ]) await t.test(label, async t => {
    const f = await setup(t, { order: [], pinned: [] }, {}, remembered);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, '/api/sessions'); assert.equal(options, undefined);
      return Response.json({ sessions });
    });
    await f.store.fetchSessions();
    assert.equal(f.store.current, expected);
    assert.equal(f.saved.has(selectionKey), Boolean(expected));
    assert.equal(f.store.loaded, true);
  });
});

test('Newly created sessions are remembered and archiving the selected session clears the preference', async t => {
  const f = await setup(t, { order: [], pinned: [] });
  const created = { ...session('new'), createdAt: '2026-09-20T01:00:00Z' };
  let sessions = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options?.method === 'POST') { sessions = [created]; return Response.json(created); }
    if (options?.method === 'DELETE') { sessions = [{ ...created, archivedAt: 'now' }]; return Response.json({ ok: true }); }
    return Response.json({ sessions });
  });
  await f.store.createSession('新会话', 'bash');
  assert.equal(f.store.current, 'new');
  assert.deepEqual(JSON.parse(f.saved.get(selectionKey)), { name: 'new', createdAt: created.createdAt });
  await f.store.removeSession('new');
  assert.equal(f.store.current, null);
  assert.equal(f.saved.has(selectionKey), false);
  await f.store.fetchSessions();
  assert.equal(f.store.current, null);
});
