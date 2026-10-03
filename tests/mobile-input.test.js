const { test } = require('node:test');
const assert = require('node:assert/strict');
const WindowsSessionManager = require('../server/services/windows-session-manager');

function manager(call) {
  const m = Object.create(WindowsSessionManager.prototype);
  m.inputQueues = new Map();
  m.sessions = new Map([['test', { name: 'test', status: 'running' }]]);
  m.call = call;
  return m;
}

test('Windows existing workers receive paste and a single Enter separately after a busy reader catches up', async () => {
  const writes = []; let consumed = false, submissions = 0;
  const m = manager(async (_session, _route, input) => {
    writes.push(input);
    if (input.text) { consumed = false; setTimeout(() => { consumed = true; }, 200); }
    if (input.key === 'Enter') { assert(consumed, 'An early Enter would be swallowed by the paste burst'); submissions++; }
    return { ok: true };
  });
  await Promise.all([m.input('test', { text: '中文\n多行', key: 'Enter' }), m.input('test', { text: '下一条', key: 'Enter' })]);
  assert.deepEqual(writes, [{ text: '中文\n多行' }, { key: 'Enter' }, { text: '下一条' }, { key: 'Enter' }]);
  assert.equal(submissions, 2);
  assert.equal(m.inputQueues.size, 0);
});

test('paste-only and navigation keep their semantics; failed paste never sends Enter or blocks later input', async () => {
  const writes = [];
  const m = manager(async (_session, _route, input) => {
    if (input.text === 'fail') throw new Error('worker disconnected');
    writes.push(input); return { ok: true };
  });
  await assert.rejects(m.input('test', { text: 'fail', key: 'Enter' }), /disconnected/);
  await m.input('test', { text: '只输入', key: null });
  await m.input('test', { key: 'S-Left' });
  await m.input('test', { key: 'Enter' });
  assert.deepEqual(writes, [{ text: '只输入', key: null }, { text: undefined, key: 'S-Left' }, { text: undefined, key: 'Enter' }]);
  assert.throws(() => m.input('test', { text: 'unsafe', key: 'Invalid' }), /Unsupported key/);
  assert.equal(writes.length, 3);
});
