const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../frontend/src/utils/activity.mjs');
test('completion colors respect outcomes, availability, read markers, and connection freshness', async () => {
  const { activityPresentation: status } = await modulePromise;
  const s = { name: 'one', shell: 'codex', status: 'running', activity: { available: true, completed: 't' } };
  assert.equal(status(s).state, 'unread');
  assert.equal(status(s, { one: 't' }).label, '已完成 · 已读');
  for (const [phase, expected] of [['thinking', 'busy'], ['executing', 'busy'], ['waiting', 'waiting'], ['interrupted', 'interrupted'], ['error', 'error'], ['unknown', 'unknown']]) {
    assert.equal(status({ ...s, activity: { ...s.activity, phase, busy: ['thinking', 'executing', 'waiting'].includes(phase) } }).state, expected);
  }
  assert.equal(status({ ...s, activity: { available: false, completed: 'old' } }).state, 'unknown');
  assert.equal(status(s, {}, true).label, '连接中断');
  assert.equal(status({ ...s, status: 'stopped' }).state, 'idle');
  assert.equal(status({ ...s, shell: 'bash', activity: { available: false } }).label, '终端就绪');
});
