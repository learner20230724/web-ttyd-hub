const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CodexUsage, normalizeUsage } = require('../server/services/codex-usage');
const { CodexQuestions, answerResult } = require('../server/services/codex-questions');

test('quota reports remaining account windows without leaking credits/auth or estimating missing data', () => {
  const limit = { limitId: 'codex', primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1792478157 }, secondary: null, credits: { balance: 'private' }, accessToken: 'secret' };
  const data = normalizeUsage({ rateLimits: limit, rateLimitsByLimitId: { codex: limit } });
  assert.equal(data.windows.length, 1); assert.equal(data.windows[0].remainingPercent, 77);
  assert.equal(data.windows[0].period, '每周额度'); assert(!JSON.stringify(data).includes('secret')); assert(!JSON.stringify(data).includes('private'));
  assert.deepEqual(normalizeUsage({}), { available: false, windows: [] });
  assert.equal(normalizeUsage({ rateLimits: { primary: { usedPercent: 110 } } }).windows[0].remainingPercent, 0);
  assert.equal(normalizeUsage({ rateLimits: { primary: { usedPercent: null } } }).available, false);
});

test('quota coalesces concurrent requests, backs off refreshes, and retains dated stale results on failure', async () => {
  let now = 100000, calls = 0, fail = false, closed = 0;
  const usage = new CodexUsage({ now: () => now, createRpc: () => ({ connect: async () => {}, call: async () => {
    calls++; if (fail) throw Error('private details');
    return { rateLimits: { primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 90 } } };
  }, close: () => closed++ }) });
  const [first, second] = await Promise.all([usage.read(), usage.read(true)]);
  assert.deepEqual(first, second); assert.equal(calls, 1);
  assert.equal(first.windows[0].remainingPercent, 40, 'An old reset timestamp must not manufacture a full balance');
  now += 2000; await usage.read(true); assert.equal(calls, 1);
  now += 6000; fail = true;
  const stale = await usage.read(true);
  assert.equal(stale.stale, true); assert.equal(stale.windows[0].remainingPercent, 40); assert.equal(stale.fetchedAt, first.fetchedAt);
  assert(!JSON.stringify(stale).includes('private details')); assert.equal(calls, closed);
});

const questions = [{ id: 'a', header: 'Choose', question: '选择方案？', options: [{ label: '方案甲', description: '说明' }] }, { id: 'b', question: '补充要求？' }];
const params = { threadId: 'thread1', turnId: 'turn1', itemId: 'item', isBlocking: true, questions };
class Rpc extends EventEmitter {
  constructor() { super(); this.sent = []; this.calls = []; this.closed = false; }
  async connect() { return this; }
  async call(method, input) {
    this.calls.push({ method, input });
    if (method === 'thread/resume') await new Promise(resolve => setImmediate(() => {
      this.emit('message', { method: 'item/tool/requestUserInput', id: 0, params: { ...params, threadId: input.threadId } }); resolve({});
    }));
    return {};
  }
  send(message) { this.sent.push(message); }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}
function fixture(t) {
  let binding = { socket: '/test/socket', threadId: 'thread1' }; const rpcs = [];
  const activity = { binding: () => binding, verifyBinding: async () => binding };
  const bridge = new CodexQuestions(activity, { createRpc: () => { const rpc = new Rpc(); rpcs.push(rpc); return rpc; } });
  t.after(() => bridge.close());
  return { bridge, rpcs, change: value => { binding = value; } };
}
test('question bridge replays only the bound thread, preserves request id zero and validates before sending', async t => {
  const { bridge, rpcs } = fixture(t);
  const [a, b] = await Promise.all([bridge.read('test'), bridge.read('test')]);
  assert.equal(a.requests.length, 1); assert.equal(a.requests[0].id, b.requests[0].id); assert.equal(rpcs[0].calls.length, 1);
  assert(bridge.hasBlocking('thread1'));
  rpcs[0].emit('message', { method: 'item/tool/requestUserInput', id: 100, params: { ...params, threadId: 'unrelated' } });
  assert.equal((await bridge.read('test')).requests.length, 1);
  const token = a.requests[0].id;
  await assert.rejects(bridge.respond('test', token, { action: 'answer', answers: { a: '方案甲' } }), /请回答每个问题/);
  assert.equal(rpcs[0].sent.length, 0);
  const result = bridge.respond('test', token, { action: 'answer', answers: { a: '方案甲', b: '中文补充\n第二行' } });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(bridge.respond('test', token, { action: 'skip' }), /正在提交/);
  assert.deepEqual(rpcs[0].sent, [{ id: 0, result: { answers: { a: { answers: ['方案甲'] }, b: { answers: ['中文补充\n第二行'] } } } }]);
  rpcs[0].emit('message', { method: 'serverRequest/resolved', params: { threadId: 'thread1', requestId: 0 } });
  assert.deepEqual(await result, { ok: true });
  assert.equal((await bridge.read('test')).requests.length, 0); assert.equal(bridge.hasBlocking('thread1'), false);
  await assert.rejects(bridge.respond('test', token, { action: 'skip' }), /已结束/);
});
test('skip answers the request with empty answers, never sends Esc or turn/interrupt', async t => {
  const { bridge, rpcs } = fixture(t); const view = await bridge.read('test');
  const response = bridge.respond('test', view.requests[0].id, { action: 'skip' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rpcs[0].sent, [{ id: 0, result: { answers: { a: { answers: [] }, b: { answers: [] } } } }]);
  rpcs[0].emit('message', { method: 'serverRequest/resolved', params: { threadId: 'thread1', requestId: 0 } });
  await response; assert.equal(rpcs[0].calls.length, 1);
});
test('switched threads, stopped/unbound sessions and a second client resolving a request reject stale replies', async t => {
  const { bridge, rpcs, change } = fixture(t); const view = await bridge.read('test'), id = view.requests[0].id;
  change({ socket: '/test/socket', threadId: 'thread2' });
  await assert.rejects(bridge.respond('test', id, { action: 'skip' }), /已结束/);
  change(null); assert.deepEqual(await bridge.read('test'), { supported: false, requests: [] });
  await assert.rejects(bridge.respond('test', id, { action: 'skip' }), /已结束/);
  change({ socket: '/test/socket', threadId: 'thread1' });
  rpcs[0].emit('message', { method: 'serverRequest/resolved', params: { threadId: 'thread1', requestId: 0 } });
  await assert.rejects(bridge.respond('test', id, { action: 'skip' }), /已结束/); assert.equal(rpcs[0].sent.length, 0);
});
test('lost connection does not silently retry an answer; a new connection replays a fresh request token', async t => {
  const { bridge, rpcs } = fixture(t); const view = await bridge.read('test'), id = view.requests[0].id;
  const response = bridge.respond('test', id, { action: 'skip' });
  await new Promise(resolve => setImmediate(resolve)); rpcs[0].close();
  await assert.rejects(response, /未确认/); assert.equal(rpcs[0].sent.length, 1);
  const replay = await bridge.read('test'); assert.notEqual(replay.requests[0].id, id);
  assert.equal(rpcs[1].sent.length, 0);
});
test('answer validation rejects oversized, control, extra and missing question values', () => {
  for (const input of [{}, { action: 'answer', answers: { a: '', b: 'ok' } }, { action: 'answer', answers: { a: 'x'.repeat(65000), b: 'ok' } }, { action: 'answer', answers: { a: '\x1b', b: 'ok' } }, { action: 'answer', answers: { a: 'ok', b: 'ok', other: 'x' } }]) assert.throws(() => answerResult(questions, input));
});
