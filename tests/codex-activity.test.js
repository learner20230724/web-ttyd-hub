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
