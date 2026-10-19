const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { WebSocket } = require('ws');
const SessionSync = require('../server/services/session-sync');
const SessionState = require('../server/services/session-state');
const routes = require('../server/routes/sessions');
const sockets = require('../server/ws');
const createdAt = '2026-10-14T00:00:00.000Z';
function fixture() {
  const manager = new EventEmitter();
  manager.sessions = new Map(['a', 'b', 'c'].map(name => [name, { name, displayName: name, createdAt, status: 'running', shell: 'codex',
    activity: { available: true, busy: false, phase: 'completed', completed: `${name}:turn-1` } }]));
  manager.list = () => [...manager.sessions.values()];
  manager.sync = new SessionSync(manager);
  return manager;
}
const read = (name, completed = `${name}:turn-1`) => ({ type: 'read', name, createdAt, completed });
const pin = (name, pinned = true) => ({ type: 'pin', name, createdAt, pinned });

test('Reads are shared, idempotent, and cannot mark a later turn or replacement session read', () => {
  const m = fixture(); let events = 0; m.on('session:sync', () => events++);
  assert.equal(m.sync.apply(read('a')).accepted, true);
  assert.deepEqual(m.sync.snapshot().read.a, { createdAt, completed: 'a:turn-1' });
  m.sync.apply({ type: 'move', name: 'a', createdAt, target: 'c', targetCreatedAt: createdAt, after: true });
  const manual = structuredClone(m.sync.snapshot());
  m.sync.apply(read('a'));
  assert.deepEqual(m.sync.snapshot(), manual, 'Repeated reads never undo manual ordering');
  m.sessions.get('a').activity.completed = 'a:turn-2';
  assert.equal(m.sync.apply(read('a')).accepted, false);
  assert.equal(m.sync.apply(read('a', 'a:turn-2')).accepted, true);
  m.sessions.get('a').createdAt = '2026-10-14T01:00:00Z';
  assert.equal(m.sync.apply(read('a', 'a:turn-2')).accepted, false);
  m.sync.prune(); assert.equal(m.sync.snapshot().read.a, undefined);
  assert.equal(events, 3);
});

test('Busy, unknown, waiting, failed, interrupted, stopped and archived sessions cannot be read', () => {
  for (const change of [{ activity: { busy: true } }, { activity: { available: false } }, ...['unknown', 'waiting', 'error', 'interrupted'].map(phase => ({ activity: { phase } })),
    { status: 'stopped' }, { archivedAt: createdAt }]) {
    const m = fixture(), session = m.sessions.get('a');
    Object.assign(session, { ...change, activity: { ...session.activity, ...change.activity } });
    assert.equal(m.sync.apply(read('a')).accepted, false);
    assert.equal(m.sync.snapshot().revision, 0);
  }
});

test('Independent clients merge pins and moves; stale initialization cannot overwrite shared layout', () => {
  const m = fixture();
  m.sync.apply({ type: 'initialize', layout: { order: ['c', 'b', 'a', 'deleted'], pinned: ['c'] } });
  m.sync.apply(pin('a')); m.sync.apply(pin('b'));
  m.sync.apply({ type: 'initialize', layout: { order: ['a', 'b', 'c'], pinned: [] } });
  assert.deepEqual(m.sync.snapshot().layout, { order: ['b', 'a', 'c'], pinned: ['c', 'a', 'b'] });
  m.sync.apply({ type: 'move', name: 'b', createdAt, target: 'c', targetCreatedAt: createdAt, after: true });
  assert.deepEqual(m.sync.snapshot().layout.order, ['a', 'c', 'b']);
  m.sync.apply(pin('c', false));
  assert.equal(m.sync.apply({ type: 'move', name: 'a', createdAt, target: 'c', targetCreatedAt: createdAt, after: true }).accepted, false);
  m.sessions.delete('b'); m.sync.prune();
  assert(!m.sync.snapshot().layout.pinned.includes('b'));
});

test('Shared receipts survive atomic persistence; failed writes roll back and never broadcast', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sync-'));
  try {
    const m = fixture(); m.state = new SessionState(path.join(directory, 'sessions.json'));
    m.sync.apply(read('a')); m.sync.apply(pin('b'));
    const restored = fixture(); restored.state = new SessionState(m.state.filename); restored.state.read(); restored.sync.restore(restored.state.shared);
    assert.deepEqual(restored.sync.snapshot(), m.sync.snapshot());
    if (process.platform !== 'win32') assert.equal(fs.statSync(m.state.filename).mode & 0o777, 0o600);
    let broadcast = false; m.on('session:sync', () => { broadcast = true; });
    const before = structuredClone(m.sync.snapshot());
    m.state.save = () => { throw new Error('disk full'); };
    assert.throws(() => m.sync.apply(read('c')), e => e.status === 503);
    assert.deepEqual(m.sync.snapshot(), before); assert.equal(broadcast, false);
    assert.throws(() => SessionSync.validate({ ...before, read: { a: { completed: 'bad' } } }));
    assert.throws(() => m.sync.apply(pin('a', 'yes')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Real API broadcasts reads to two clients and returns uncached shared snapshots', async t => {
  const m = fixture(), app = express(); app.use(express.json()); app.use('/api/sessions', routes(m));
  const server = app.listen(0, '127.0.0.1'), wss = sockets(server, m); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [new WebSocket(base.replace('http', 'ws') + '/ws'), new WebSocket(base.replace('http', 'ws') + '/ws')];
  t.after(async () => { for (const client of clients) client.terminate(); for (const client of wss.clients) client.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const snapshots = clients.map(client => once(client, 'message'));
  await Promise.all(clients.map(client => once(client, 'open')));
  for (const [message] of await Promise.all(snapshots)) {
    const snapshot = JSON.parse(message);
    assert.equal(snapshot.event, 'session:snapshot');
    assert.equal(snapshot.data.sessions.length, m.list().length);
    assert.deepEqual(snapshot.data.shared, m.sync.snapshot());
  }
  const messages = clients.map(client => once(client, 'message'));
  const res = await fetch(base + '/api/sessions/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(read('a')) });
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  for (const [message] of await Promise.all(messages)) {
    const notification = JSON.parse(message);
    assert.equal(notification.event, 'session:sync');
    assert.equal(notification.data.read.a.completed, 'a:turn-1', 'No second HTTP round trip is needed');
  }
  const list = await fetch(base + '/api/sessions'); assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal((await list.json()).shared.read.a.completed, 'a:turn-1');
});
