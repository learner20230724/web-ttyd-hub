const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyEvent } = require('../server/services/codex-activity');

test('question tool acknowledgement clears the pending mobile input although chat history stays unchanged', async () => {
  const { reconcileInputs, receiptCandidates } = await import('../frontend/src/utils/input-receipts.mjs');
  const state = { messages: [], sequence: 0 };
  const messages = [{ id: 'old', role: 'user', text: '之前的提问' }];
  const pending = [{ id: 'pending', text: '我的补充\r\n第二行', before: ['old'], status: 'delivered' }];
  assert.equal(reconcileInputs(pending, { messages }).length, 1, 'Sending to the terminal alone is not a Codex receipt');
  applyEvent(state, { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'question' } });
  applyEvent(state, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'question', output: JSON.stringify({ answers: { choice: { answers: ['Option A', 'user_note: 我的补充\n第二行'] } } }) } });
  const data = { messages, inputReceipts: state.inputReceipts };
  assert.equal(reconcileInputs(pending, data).length, 0);
  assert.equal(reconcileInputs([{ ...pending[0], before: receiptCandidates(data).map(r => r.id) }], data).length, 1, 'An older identical answer cannot confirm a new send');
});

test('ordinary, duplicate, delayed and failed sends require their own matching receipt', async () => {
  const { reconcileInputs } = await import('../frontend/src/utils/input-receipts.mjs');
  let pending = ['a', 'b'].map(id => ({ id, text: '重复文字', before: [], status: 'uncertain' }));
  pending = reconcileInputs(pending, { messages: [{ id: 'assistant', role: 'assistant', text: '重复文字' }] });
  assert.equal(pending.length, 2);
  const first = { id: 'one', role: 'user', text: '重复文字' };
  pending = reconcileInputs(pending, { messages: [first] }); assert.equal(pending.length, 1);
  pending = reconcileInputs(pending, { messages: [first] }); assert.equal(pending.length, 1);
  pending = reconcileInputs(pending, { messages: [first, { ...first, id: 'two' }] }); assert.equal(pending.length, 0);
  const none = [{ text: 'not received', before: [], status: 'uncertain' }];
  assert.equal(reconcileInputs(none, { text: 'terminal screen', activity: { busy: false } }).length, 1);
});
