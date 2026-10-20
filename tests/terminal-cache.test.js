const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SnapshotCache, TerminalStream } = require('../server/services/terminal-stream');
const snapshot = text => ({ type: 'snapshot', meta: { pane_width: 100, pane_height: 30 },
  screen: text, normal: '', history: '', alternate: '', pending: '' });

test('terminal snapshot patches restore unchanged, appended and rewritten history exactly', async () => {
  const { applyTerminalDelta } = await import('../frontend/src/utils/terminal-cache.mjs');
  const cache = new SnapshotCache(), scope = 'session:generation';
  const first = cache.response(scope, snapshot('line 中文😀\n'.repeat(1000)));
  const unchanged = cache.response(scope, snapshot(first.screen), first.digest);
  assert.equal(unchanged.type, 'snapshot-delta');
  assert.deepEqual(unchanged.changes, {});
  assert.deepEqual(applyTerminalDelta(first, unchanged), first);
  const next = snapshot(first.screen + '\x1b[32mnew output\x1b[0m\n');
  next.meta = { ...next.meta, cursor_x: 4 };
  const appended = cache.response(scope, next, first.digest);
  assert.equal(appended.type, 'snapshot-delta');
  assert.equal(applyTerminalDelta(first, appended).screen, next.screen);
  assert.deepEqual(applyTerminalDelta(first, appended).meta, next.meta);
  assert(Buffer.byteLength(JSON.stringify(appended)) < Buffer.byteLength(JSON.stringify(next)) / 10);
  const rewritten = snapshot(first.screen.replace('中文😀', '改写👋'));
  const patched = cache.response(scope, rewritten, first.digest);
  assert.equal(applyTerminalDelta(first, patched).screen, rewritten.screen);
});

test('unknown, evicted and other-generation terminal baselines fall back to a full snapshot', () => {
  const cache = new SnapshotCache(2500);
  const first = cache.response('name:old', snapshot('a'.repeat(1500)));
  assert.equal(cache.response('name:new', snapshot(first.screen), first.digest).type, 'snapshot');
  assert.equal(cache.response('name:old', snapshot('a'.repeat(1500)), first.digest).type, 'snapshot');
  assert(cache.bytes <= 2500);
  assert.equal(cache.response('name:new', snapshot('b'.repeat(1500)), '0'.repeat(64)).type, 'snapshot');
});

test('terminal cache accepts raw persisted bytes and rejects malformed snapshots and patches', async () => {
  const { terminalCache, applyTerminalDelta, encodeTerminalBytes, decodeTerminalBytes } = await import('../frontend/src/utils/terminal-cache.mjs');
  const cache = new SnapshotCache(), first = cache.response('name:generation', snapshot('历史\n'.repeat(1000)));
  const bytes = Uint8Array.from([0, 27, 255, 228, 184, 173]);
  const data = { version: 1, snapshot: first, updates: [encodeTerminalBytes(bytes.buffer)] };
  assert.deepEqual(decodeTerminalBytes(data.updates[0]), bytes);
  assert.deepEqual(terminalCache(data), data);
  assert.equal(terminalCache({ ...data, version: 0 }), null);
  assert.equal(terminalCache({ ...data, snapshot: { ...first, meta: { pane_width: 9999 } } }), null);
  assert.equal(terminalCache({ ...data, updates: ['bad!'] }), null);
  assert.throws(() => applyTerminalDelta(first, { type: 'snapshot-delta', base: 'wrong', changes: {} }));
  assert.throws(() => applyTerminalDelta(first, { type: 'snapshot-delta', base: first.digest, changes: { screen: [-1, 0, 'bad'] } }));
  assert.throws(() => applyTerminalDelta(first, { type: 'snapshot-delta', base: first.digest, changes: { other: [0, 0, 'bad'] } }));
});

test('terminal checkpoint deltas carry the new completion even when its visible screen is unchanged', async () => {
  const { applyTerminalDelta } = await import('../frontend/src/utils/terminal-cache.mjs');
  const cache = new SnapshotCache();
  const first = cache.response('same:generation', { ...snapshot('unchanged screen\n'.repeat(500)), generation: 'generation', completed: 't1' });
  const next = cache.response('same:generation', { ...snapshot(first.screen), generation: 'generation', completed: 't2' }, first.digest);
  assert.equal(next.type, 'snapshot-delta'); assert.deepEqual(next.changes, {});
  assert.equal(applyTerminalDelta(first, next).completed, 't2');
});

test('terminal snapshots keep the completion captured before tmux starts reading', async () => {
  const session = { name: 'synthetic', createdAt: 'generation', activity: { completed: 't1' } };
  const messages = [], ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, send: text => messages.push(JSON.parse(text)), close() { this.readyState = 3; } });
  const stream = new TerminalStream(ws, session.name, { getSession: () => session }, new SnapshotCache());
  let finish;
  stream.command = () => new Promise((resolve, reject) => {
    const job = { resolve, reject }; stream.pending.push(job);
    finish = replies => { stream.pending.shift(); job.resolve(replies); };
  });
  try {
    const capturing = stream.snapshot();
    session.activity.completed = 't2';
    const meta = ['%1', 80, 24, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 23, ''];
    finish([Buffer.from(meta.join('|') + '\n'), Buffer.from('older captured content\n'), ...Array.from({ length: 4 }, () => Buffer.from('\n'))]);
    await capturing;
    assert.equal(messages[0].completed, 't1');
    assert.equal(messages[0].generation, 'generation');
  } finally { stream.close(); }
});
