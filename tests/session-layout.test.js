const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../frontend/src/utils/session-layout.mjs');
const sessions = ['a', 'b', 'c', 'd'].map(name => ({ name }));

test('Pinned sessions stay first, saved order survives API order changes, new sessions append', async () => {
  const { orderedSessions } = await modulePromise;
  const layout = { order: ['c', 'b', 'a'], pinned: ['a', 'b'] };
  assert.deepEqual(orderedSessions(sessions, layout).map(s => s.name), ['b', 'a', 'c', 'd']);
  assert.deepEqual(orderedSessions([...sessions].reverse(), layout).map(s => s.name), ['b', 'a', 'c', 'd']);
});
test('Move before/after without crossing pinned groups or changing selection IDs', async () => {
  const { moveSession, orderedSessions } = await modulePromise;
  const layout = { order: ['a', 'b', 'c', 'd'], pinned: ['a'] };
  const moved = moveSession(sessions, layout, 'd', 'b');
  assert.deepEqual(orderedSessions(sessions, moved).map(s => s.name), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveSession(sessions, layout, 'b', 'd', true).order, ['a', 'c', 'd', 'b']);
  assert.equal(moveSession(sessions, layout, 'a', 'd'), layout);
  assert.equal(moveSession(sessions, layout, 'missing', 'b'), layout);
  assert.deepEqual(layout.order, ['a', 'b', 'c', 'd']);
});
test('Malformed stored preferences are normalized without losing valid IDs', async () => {
  const { normalizeLayout } = await modulePromise;
  assert.deepEqual(normalizeLayout(null), { order: [], pinned: [] });
  assert.deepEqual(normalizeLayout({ order: ['a', 12, 'a', 'b'], pinned: false }), { order: ['a', 'b'], pinned: [] });
});
