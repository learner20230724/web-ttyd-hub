const { test } = require('node:test');
const assert = require('node:assert/strict');
const metadata = import('../frontend/src/utils/session-metadata.mjs');
const snapshot = () => ({ version: 1, sessions: [{ name: 'reader', createdAt: 'generation-one', displayName: '本地会话', shell: 'codex', status: 'running',
  activity: { available: true, busy: false, phase: 'completed', completed: 'answer-one', startedAt: '2026-10-20T00:00:00Z' } }],
  read: { reader: 'answer-one' }, layout: { order: ['reader'], pinned: ['reader'] }, selection: { name: 'reader', createdAt: 'generation-one' },
  shells: [{ id: 'codex', name: 'Codex' }], platform: 'linux' });

test('metadata round trip preserves reopen state while excluding credentials, quota and process details', async () => {
  const { saveMetadata, loadMetadata } = await metadata;
  let saved;
  const storage = { setItem: (_key, json) => { saved = json; }, getItem: () => saved };
  const data = snapshot();
  data.apiKey = 'PRIVATE_KEY'; data.quota = { remaining: 42 };
  Object.assign(data.sessions[0], { pid: 123, port: 456, credential: 'PRIVATE_CREDENTIAL' });
  data.shells[0].path = '/private/shell-path';
  data.sessions[0].activity.error = 'PRIVATE_ERROR_BODY';
  assert.equal(saveMetadata(data, storage), true);
  assert.doesNotMatch(saved, /PRIVATE|quota|remaining|"pid"|"port"|shell-path/);
  const restored = loadMetadata(storage);
  assert.deepEqual(restored.selection, data.selection);
  assert.deepEqual(restored.layout, data.layout);
  assert.equal(restored.read.reader, 'answer-one');
  assert.equal(restored.sessions[0].activity.error, true);
  assert.equal(restored.platform, 'linux');
});

test('metadata refuses corrupt schemas and never selects another generation or an archived session', async () => {
  const { normalizeMetadata, loadMetadata } = await metadata;
  assert.equal(loadMetadata({ getItem: () => '{not-json' }), null);
  assert.equal(normalizeMetadata({ ...snapshot(), version: 2 }), null);
  const data = snapshot();
  data.selection.createdAt = 'other-generation';
  assert.equal(normalizeMetadata(data).selection, null);
  data.selection.createdAt = 'generation-one'; data.sessions[0].archivedAt = '2026-10-20';
  assert.equal(normalizeMetadata(data).selection, null);
  data.layout.order.push('deleted'); data.layout.pinned.push('deleted');
  assert.deepEqual(normalizeMetadata(data).layout, { order: ['reader'], pinned: ['reader'] });
});

test('blocked or full browser storage cannot stop startup and separate Hub mounts keep distinct snapshots', async () => {
  const { saveMetadata, loadMetadata } = await metadata;
  const blocked = { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('quota'); } };
  assert.equal(loadMetadata(blocked), null);
  assert.equal(saveMetadata(snapshot(), blocked), false);
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  saveMetadata(snapshot(), storage, 'root');
  const home = snapshot(); home.sessions[0].displayName = '家中终端';
  saveMetadata(home, storage, 'home-terminal');
  assert.equal(loadMetadata(storage, 'root').sessions[0].displayName, '本地会话');
  assert.equal(loadMetadata(storage, 'home-terminal').sessions[0].displayName, '家中终端');
});
