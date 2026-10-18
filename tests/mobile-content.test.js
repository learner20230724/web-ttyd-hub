const { test } = require('node:test');
const assert = require('node:assert/strict');
const contentResponse = require('../server/services/content-response');

for (const [platform, Manager] of [
  ['Linux', require('../server/services/session-manager')],
  ['Windows', require('../server/services/windows-session-manager')],
]) {
  test(`${platform} content acknowledges only the completion present before capture`, async () => {
    const session = { activity: { phase: 'completed', completed: 'old-turn' } };
    const manager = {
      ensurePane: async () => {}, getSession: () => session,
      activity: { messages: () => [{ id: 'reply', text: 'A completed reply' }], inputReceipts: () => [] },
      history: async () => { session.activity = { phase: 'completed', completed: 'new-turn' }; return { text: 'Old terminal snapshot' }; },
    };
    const answer = await Manager.prototype.mobile.call(manager, 'fixture');
    assert.equal(answer.completed, 'old-turn');
    assert.equal(answer.messages.length, 1);
    const full = await Manager.prototype.mobile.call(manager, 'fixture', true);
    assert.equal(full.completed, 'old-turn', 'A new completion during capture is not proof it is in the captured output');
    assert.equal(session.activity.completed, 'new-turn');
    assert.equal(full.text, 'Old terminal snapshot');
  });
}

test('completion changes invalidate a content ETag even when the reply text is unchanged', () => {
  const response = () => ({ headers: {}, code: 200, set(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; }, end() {}, json(data) { this.data = data; } });
  const first = response();
  contentResponse({ headers: {} }, first, { text: 'Reply', completed: null, activity: { busy: true } });
  const completed = response();
  contentResponse({ headers: { 'if-none-match': first.headers.ETag } }, completed,
    { text: 'Reply', completed: 'finished-turn', activity: { busy: false } });
  assert.equal(completed.code, 200);
  assert.equal(completed.data.completed, 'finished-turn');
  assert.notEqual(first.headers.ETag, completed.headers.ETag);
  const unchanged = response();
  contentResponse({ headers: { 'if-none-match': completed.headers.ETag } }, unchanged,
    { text: 'Reply', completed: 'finished-turn', capturedAt: 'later' });
  assert.equal(unchanged.code, 304);
});
