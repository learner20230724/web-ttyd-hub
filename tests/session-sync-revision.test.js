const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SessionSync = require('../server/services/session-sync');
const SessionState = require('../server/services/session-state');
const createdAt = '2026-10-25T00:00:00Z';
const marker = contentRevision => ({ createdAt, completed: 'turn-one', ...(contentRevision ? { contentRevision } : {}) });

function fixture(revision = 'r2') {
  const manager = new EventEmitter(), saved = [], broadcasts = [];
  manager.sessions = new Map([['reader', { name: 'reader', createdAt, shell: 'codex', status: 'running',
    activity: { available: true, busy: false, phase: 'completed', completed: 'turn-one', ...(revision ? { contentRevision: revision } : {}) } }]]);
  manager.list = () => [...manager.sessions.values()];
  manager.state = { save(_sessions, shared) { saved.push(structuredClone(shared)); } };
  manager.sync = new SessionSync(manager);
  manager.on('session:sync', shared => broadcasts.push(structuredClone(shared)));
  return { manager, saved, broadcasts, op: revision => ({ type: 'read', name: 'reader', createdAt, completed: 'turn-one',
    ...(revision !== undefined ? { contentRevision: revision } : {}) }) };
}

test('a stale dialogue revision cannot acknowledge a later final reply with the same completion token', () => {
  const f = fixture('r2');
  assert.equal(f.manager.sync.apply(f.op('r1')).accepted, false);
  assert.equal(f.manager.sync.snapshot().read.reader, undefined);
  assert.equal(f.saved.length, 0); assert.equal(f.broadcasts.length, 0);
  assert.equal(f.manager.sync.apply(f.op('r2')).accepted, true);
  assert.deepEqual(f.manager.sync.snapshot().read.reader, marker('r2'));
  assert.equal(f.saved.length, 1); assert.equal(f.broadcasts.length, 1);
  const before = structuredClone(f.manager.sync.snapshot());
  f.manager.sync.apply(f.op('r2'));
  assert.deepEqual(f.manager.sync.snapshot(), before, 'Repeated matching reads are idempotent');
  assert.equal(f.saved.length, 1); assert.equal(f.broadcasts.length, 1);
});

test('confirming a newer revision of the same completed turn persists and broadcasts its new read marker', () => {
  const f = fixture('r1');
  f.manager.sync.apply(f.op('r1'));
  const before = f.manager.sync.snapshot().revision;
  f.manager.sessions.get('reader').activity.contentRevision = 'r2';
  assert.equal(f.manager.sync.apply(f.op('r1')).accepted, false);
  assert.equal(f.manager.sync.apply(f.op('r2')).accepted, true);
  assert.equal(f.manager.sync.snapshot().revision, before + 1);
  assert.deepEqual(f.manager.sync.snapshot().read.reader, marker('r2'));
  assert.deepEqual(f.saved.at(-1).read.reader, marker('r2'));
  assert.deepEqual(f.broadcasts.at(-1).read.reader, marker('r2'));
  assert.equal(f.saved.length, 2); assert.equal(f.broadcasts.length, 2);
});

test('legacy reads cannot acknowledge a versioned answer', () => {
  const f = fixture('r2');
  assert.equal(f.manager.sync.apply(f.op()).accepted, false);
  assert.equal(f.manager.sync.snapshot().read.reader, undefined);
  const oldServer = fixture(null);
  assert.equal(oldServer.manager.sync.apply(oldServer.op()).accepted, true);
  assert.deepEqual(oldServer.manager.sync.snapshot().read.reader, marker());
  assert.equal(oldServer.manager.sync.apply(oldServer.op('r1')).accepted, false, 'An explicit revision requires an actual match');
});

test('binding a legacy already-read marker to its rendered revision saves quietly without changing manual order', () => {
  const f = fixture('r2');
  f.manager.sessions.set('other', { ...f.manager.sessions.get('reader'), name: 'other' });
  const layout = { order: ['other', 'reader'], pinned: [] };
  f.manager.sync.restore({ revision: 7, read: { reader: marker() }, layout });
  assert.equal(f.manager.sync.apply(f.op('r2')).accepted, true);
  assert.deepEqual(f.manager.sync.snapshot().read.reader, marker('r2'));
  assert.deepEqual(f.manager.sync.snapshot().layout, layout, 'Adding a missing version is not a newly read reply');
  assert.equal(f.manager.sync.snapshot().revision, 8);
  assert.equal(f.saved.length, 1); assert.equal(f.broadcasts.length, 1);
  // Once a concrete revision was read, a different concrete revision is a new
  // unread body even when the completion token did not change.
  f.manager.sessions.get('reader').activity.contentRevision = 'r3';
  f.manager.sync.apply(f.op('r3'));
  assert.deepEqual(f.manager.sync.snapshot().layout.order, ['reader', 'other']);
});

test('old persisted read snapshots restore without adding revision fields or making old reads disappear', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-read-revision-'));
  try {
    const f = fixture('r2');
    const legacy = { revision: 9, read: { reader: marker() }, layout: { order: ['reader'], pinned: [] } };
    const disk = new SessionState(path.join(directory, 'sessions.json'));
    disk.save(f.manager.list(), legacy);
    const reopened = new SessionState(disk.filename); reopened.read();
    f.manager.sync.restore(reopened.shared);
    assert.deepEqual(f.manager.sync.snapshot(), legacy);
    assert.equal(f.saved.length, 0); assert.equal(f.broadcasts.length, 0);
    const revised = { ...legacy, read: { reader: marker('r1') } };
    assert.deepEqual(SessionSync.validate(revised), revised);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('optional read revisions reject empty, non-string or excessive values in operations and saved state', () => {
  for (const value of ['', null, 0, false, {}, [], 'r'.repeat(257)]) {
    const f = fixture();
    assert.throws(() => f.manager.sync.apply(f.op(value)), /已读|版本/);
    assert.throws(() => SessionSync.validate({ revision: 1, read: { reader: { ...marker(), contentRevision: value } }, layout: null }));
  }
  const f = fixture('r'.repeat(256));
  assert.equal(f.manager.sync.apply(f.op('r'.repeat(256))).accepted, true);
});

test('a failed save cannot advance or broadcast a newer read revision', () => {
  const f = fixture('r1'); f.manager.sync.apply(f.op('r1'));
  const before = structuredClone(f.manager.sync.snapshot());
  f.manager.sessions.get('reader').activity.contentRevision = 'r2';
  f.manager.state.save = () => { throw Error('Synthetic disk failure'); };
  assert.throws(() => f.manager.sync.apply(f.op('r2')), error => error.status === 503);
  assert.deepEqual(f.manager.sync.snapshot(), before);
  assert.equal(f.broadcasts.length, 1);
});
