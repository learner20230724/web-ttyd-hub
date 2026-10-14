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

test('Unread badge excludes the current session even without focus and counts other completed sessions once', async t => {
  const f = await setup(t, { order: [], pinned: ['other'] });
  const sessions = [session('current', { completed: 't1' }), session('other', { completed: 't2' }),
    session('busy', { busy: true, completed: 'old' }), session('plain'),
    { ...session('archived', { completed: 't3' }), archivedAt: 'now' },
    { ...session('stopped', { completed: 't4' }), status: 'stopped' }];
  await f.update(sessions);
  assert.equal(f.store.unreadCount, 2);
  f.doc.focused = false;
  f.store.select('current'); await f.nextTick();
  assert.equal(f.store.activityState(f.store.sessions[0]), 'unread');
  assert.equal(f.store.unreadCount, 1, 'Selected session is excluded independently of its read marker');
  sessions[0].activity.completed = 't1-new';
  sessions[2].activity = { completed: 'busy-finished' };
  await f.update(sessions);
  assert.equal(f.store.unreadCount, 2);
  f.doc.focused = true;
  f.win.dispatchEvent(new Event('focus'));
  f.store.select('other'); await f.nextTick();
  assert.equal(f.store.unreadCount, 1);
  f.store.select('busy'); await f.nextTick();
  assert.equal(f.store.unreadCount, 0);
  await f.update(sessions);
  assert.equal(f.store.unreadCount, 0);
  sessions[1].activity.completed = 't2-next';
  await f.update(sessions);
  assert.equal(f.store.unreadCount, 1);
  sessions[1].archivedAt = 'now';
  await f.update(sessions);
  assert.equal(f.store.unreadCount, 0);
});

test('Working count excludes the current session, updates on selection, and excludes waiting, stopped, archived and offline sessions', async t => {
  const f = await setup(t, { order: [], pinned: ['thinking'] });
  const sessions = ['working', 'thinking', 'responding', 'executing', 'retrying'].map(phase => session(phase, { phase, busy: true }));
  sessions.push(session('waiting', { phase: 'waiting', busy: true }),
    session('completed', { completed: 'done' }), session('error', { phase: 'error' }),
    session('interrupted', { phase: 'interrupted' }), session('unknown', { phase: 'unknown', available: false }),
    { ...session('stopped', { busy: true }), status: 'stopped' },
    { ...session('archived', { busy: true }), archivedAt: 'now' });
  await f.update(sessions);
  assert.equal(f.store.workingCount, 5, 'With no selected session, all five workers are counted once');
  f.doc.focused = false;
  f.store.select('working'); await f.nextTick();
  assert.equal(f.store.workingCount, 4, 'Selected worker is excluded even when the page is not focused');
  f.store.select('thinking'); await f.nextTick();
  assert.equal(f.store.workingCount, 4, 'Switching workers counts the previous one and excludes the new one');
  f.store.select('working'); await f.nextTick();
  f.doc.focused = true;
  sessions[0].activity = { completed: 'selected-done' };
  await f.update(sessions);
  assert.equal(f.store.workingCount, 4);
  assert.equal(f.store.unreadCount, 1, 'The selected completion is read while the other completion stays unread');
  f.store.select('completed'); await f.nextTick();
  assert.equal(f.store.workingCount, 4, 'Reading another session does not change the working count');
  f.store.select('thinking'); await f.nextTick();
  assert.equal(f.store.workingCount, 3, 'Opening a running session removes it from the count immediately');
  f.store.connectionIssue = true;
  assert.equal(f.store.workingCount, 0, 'Do not present stale work as current when disconnected');
  f.store.connectionIssue = false;
  assert.equal(f.store.workingCount, 3);
  f.store.select(null); await f.nextTick();
  assert.equal(f.store.workingCount, 4);
  await f.update([session('only-worker', { phase: 'executing', busy: true })]);
  f.store.select('only-worker'); await f.nextTick();
  assert.equal(f.store.workingCount, 0, 'Only the current session is working');
  await f.update([]);
  assert.equal(f.store.workingCount, 0);
});

test('Unread shortcut follows visible pinned/manual order, skips the current item, and stops after all are read', async t => {
  const f = await setup(t, { order: ['gray', 'current', 'second', 'first', 'pinned'], pinned: ['pinned'] });
  await f.update([session('first', { completed: 't1' }), session('second', { completed: 't2' }),
    session('pinned', { completed: 't3' }), session('current', { completed: 't4' }), session('gray')]);
  f.store.select('current'); await f.nextTick();
  assert.equal(f.store.unreadCount, 3);
  for (const [name, remaining] of [['pinned', 2], ['second', 1], ['first', 0]]) {
    assert.equal(f.order().find(name => name !== f.store.current && f.store.activityState(f.store.sessions.find(s => s.name === name)) === 'unread'), name);
    f.store.selectNextUnread(); await f.nextTick();
    assert.equal(f.store.current, name);
    assert.equal(f.store.unreadCount, remaining);
    assert.equal(f.store.activityState(f.store.sessions.find(s => s.name === name)), 'idle');
  }
  f.store.selectNextUnread(); await f.nextTick();
  assert.equal(f.store.current, 'first');
  assert.equal(f.store.unreadCount, 0);
});

test('Working shortcut cycles through every worker in pinned/manual order and follows manual selection or reordering', async t => {
  const f = await setup(t, { order: ['other', 'second', 'first', 'third'], pinned: ['third'] });
  await f.update([session('first', { busy: true }), session('second', { busy: true }),
    session('third', { busy: true }), session('other')]);
  f.store.select('other'); await f.nextTick();
  assert.equal(f.store.workingCount, 3);
  const layoutBefore = f.saved.get(layoutKey);
  for (const name of ['third', 'second', 'first', 'third', 'second', 'first']) {
    f.store.selectNextWorking(); await f.nextTick();
    assert.equal(f.store.current, name);
    assert.equal(f.store.workingCount, 2, 'The chosen worker is excluded from the displayed count');
  }
  assert.equal(f.saved.get(layoutKey), layoutBefore, 'Cycling does not reorder the list');
  f.store.select('second'); await f.nextTick();
  f.store.selectNextWorking(); await f.nextTick();
  assert.equal(f.store.current, 'first', 'Manual selection becomes the starting point');
  f.store.reorderSession('first', 'second', false);
  f.store.selectNextWorking(); await f.nextTick();
  assert.equal(f.store.current, 'second', 'Use the current manual order');
  f.store.selectNextWorking(); await f.nextTick();
  assert.equal(f.store.current, 'third', 'Wrap across pinned and regular workers');
});

test('Working shortcut uses live states, alternates two workers, and cannot select completed, waiting, stopped, archived or offline sessions', async t => {
  const f = await setup(t, { order: ['a', 'b', 'c'], pinned: [] });
  const sessions = [session('a', { busy: true }), session('b', { busy: true }), session('c', { busy: true }),
    session('waiting', { phase: 'waiting', busy: true }),
    { ...session('stopped', { busy: true }), status: 'stopped' },
    { ...session('archived', { busy: true }), archivedAt: 'now' }];
  await f.update(sessions);
  f.store.select('a'); await f.nextTick();
  sessions[2].activity = { completed: 'c-done' };
  await f.update(sessions);
  for (const name of ['b', 'a', 'b', 'a']) {
    f.store.selectNextWorking(); await f.nextTick();
    assert.equal(f.store.current, name);
    assert.equal(f.store.workingCount, 1);
  }
  sessions[1].archivedAt = 'now';
  await f.update(sessions);
  f.store.selectNextWorking(); await f.nextTick();
  assert.equal(f.store.current, 'a');
  assert.equal(f.store.workingCount, 0, 'Only the current worker remains');
  sessions[0].activity = { completed: 'a-done' };
  await f.update(sessions);
  f.store.selectNextWorking(); await f.nextTick();
  assert.equal(f.store.current, 'a', 'No workers is a no-op');
  sessions[1].archivedAt = null;
  await f.update(sessions);
  f.store.connectionIssue = true;
  f.store.selectNextWorking(); await f.nextTick();
  assert.equal(f.store.current, 'a', 'Do not navigate using stale offline status');
  f.store.connectionIssue = false;
  f.store.selectNextWorking(); await f.nextTick();
  assert.equal(f.store.current, 'b', 'A newly available worker is included');
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
      assert.equal(url, '/api/sessions'); assert.ok(options.signal instanceof AbortSignal); assert.equal(options.method, undefined);
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
