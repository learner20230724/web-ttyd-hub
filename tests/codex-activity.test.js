const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyEvent } = require('../server/services/codex-activity');
const state = () => ({ busy: false, completed: null, messages: [], sequence: 0 });
const event = (type, turn = 'one') => ({ type: 'event_msg', timestamp: '2026-09-18T00:00:00Z', payload: { type, turn_id: turn } });
test('Codex completion uses explicit turn events, ignores unrelated turn completion', () => {
  const s = state(); applyEvent(s, event('task_started')); assert.equal(s.busy, true);
  applyEvent(s, event('token_count')); assert.equal(s.busy, true);
  applyEvent(s, event('task_complete', 'other')); assert.equal(s.busy, true);
  applyEvent(s, event('task_complete')); assert.equal(s.busy, false); assert.match(s.completed, /:one$/);
  applyEvent(s, event('task_started', 'two')); applyEvent(s, event('turn_aborted', 'two'));
  assert.equal(s.busy, false); assert.match(s.completed, /:one$/);
});
test('Mobile feed excludes developer, tools and analysis and bounds retained messages', () => {
  const s = state();
  const message = (role, channel) => ({ type: 'response_item', timestamp:'now', payload:{ type:'message', role, channel, content:[{type:'output_text',text:'hello'}] } });
  applyEvent(s, message('developer')); applyEvent(s, message('assistant','analysis')); assert.equal(s.messages.length,0);
  for (let i=0;i<320;i++) applyEvent(s, message('assistant'));
  assert.equal(s.messages.length,300); assert.equal(s.messages[0].id,'now:20');
});
test('Mobile feed hides initial environment/AGENTS metadata and shows explicit Codex failures', () => {
  const s = state();
  applyEvent(s, { type: 'response_item', timestamp: 'now', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: '# AGENTS.md instructions\nprivate instructions' },
    { type: 'input_text', text: '<environment_context>private metadata' }
  ] } });
  assert.equal(s.messages.length, 0);
  applyEvent(s, { ...event('task_complete'), payload: { type: 'task_complete', turn_id: 'one', error: { message: 'CLI upgrade required' } } });
  assert.equal(s.busy, false); assert.match(s.messages[0].text, /CLI upgrade required/);
});

test('question answer and user_note results confirm input without exposing other tool output', () => {
  const s = state();
  const call = (id, name = 'request_user_input') => applyEvent(s, { type: 'response_item', payload: { type: 'function_call', name, call_id: id } });
  const output = (id, value) => applyEvent(s, { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: value } });
  const answer = JSON.stringify({ answers: { choice: { answers: ['Option A', 'user_note: 追问内容\n第二行'] } }, private_tool_detail: 'must not appear' });
  call('other', 'exec_command'); output('other', answer);
  output('unknown', answer); assert.equal(s.inputReceipts, undefined);
  call('question', 'functions.request_user_input'); output('question', answer);
  assert.deepEqual(s.inputReceipts.map(r => r.text), ['Option A', '追问内容\n第二行']);
  assert.equal(s.messages.length, 0, 'Do not render question tool results as conversation output');
  output('question', answer); assert.equal(s.inputReceipts.length, 2, 'A repeated output is not a second acknowledgement');
  call('broken'); output('broken', '{'); assert.equal(s.inputReceipts.length, 2);
  call('invalid'); output('invalid', { answers: { x: { answers: [null, {}, '', 'x'.repeat(64001)] } } });
  assert.equal(s.inputReceipts.length, 2);
  for (let i = 0; i < 310; i++) { call('q' + i); output('q' + i, { answers: { x: { answers: ['note ' + i] } } }); }
  assert.equal(s.inputReceipts.length, 300);
});
