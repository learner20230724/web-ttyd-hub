const { test } = require('node:test');
const assert = require('node:assert/strict');
const contentResponse = require('../server/services/content-response');
const { CodexActivity } = require('../server/services/codex-activity');

for (const [platform, Manager] of [
  ['Linux', require('../server/services/session-manager')],
  ['Windows', require('../server/services/windows-session-manager')],
]) {
  test(`${platform} holds the first answer through source warm-up while full remains immediate`, async t => {
    const session = { name: 'fixture', status: 'running', shell: 'codex', activity: { available: false } };
    const replies = [{ id: 'final', role: 'assistant', text: 'Saved final reply before any new input' }];
    const activity = new CodexActivity({ sessions: new Map([[session.name, session]]), emit() {}, serialize: s => s }, { interval: 60000 });
    t.after(() => activity.close()); clearInterval(activity.timer);
    let polls = 0, answered = false, captures = 0;
    activity.poll = async () => { polls++; };
    const manager = { activity, ensurePane: async () => {}, getSession: () => session,
      history: async () => { captures++; return { text: 'Full terminal output' }; } };
    const first = Manager.prototype.mobile.call(manager, session.name).then(data => { answered = true; return data; });
    const second = Manager.prototype.mobile.call(manager, session.name);
    await new Promise(resolve => setImmediate(resolve));
    const full = await Manager.prototype.mobile.call(manager, session.name, true);
    assert.equal(full.text, 'Full terminal output');
    assert.equal(answered, false, 'First answer must wait for initialization instead of returning terminal output');
    assert.equal(polls, 1, 'Concurrent answer requests share one warm-up observation');
    activity.states.set(session.name, { messages: replies });
    activity.publish(session, { available: true, busy: false, phase: 'completed', completed: 'saved-turn' });
    for (const result of await Promise.all([first, second])) {
      assert.deepEqual(result.messages, replies); assert.equal(result.completed, 'saved-turn');
      assert.equal(result.text, undefined);
    }
    assert.equal(captures, 1, 'Only the explicit full request captures terminal output');
  });

  test(`${platform} a verified new conversation has an empty answer instead of masquerading as terminal output`, async () => {
    const session = { shell: 'codex', activity: { available: true, phase: 'idle' } };
    let captures = 0;
    const manager = { ensurePane: async () => {}, getSession: () => session,
      activity: { messages: () => [], inputReceipts: () => [] },
      history: async () => { captures++; return { text: 'Welcome to the terminal' }; } };
    const answer = await Manager.prototype.mobile.call(manager, 'fixture');
    assert.deepEqual(answer.messages, []); assert.equal(answer.text, undefined); assert.equal(captures, 0);
    assert.equal((await Manager.prototype.mobile.call(manager, 'fixture', true)).text, 'Welcome to the terminal');
  });

  test(`${platform} loads the bound dialogue before falling back during the first observation`, async () => {
    const session = { shell: 'codex', activity: { available: false } };
    const replies = [{ id: 'final', role: 'assistant', text: 'Actual final reply' }];
    let messages = null, polls = 0;
    const manager = {
      ensurePane: async () => {}, getSession: () => session,
      activity: { messages: () => messages, inputReceipts: () => [], poll: async () => {
        polls++; messages = replies; session.activity = { available: true, phase: 'completed', completed: 'one' };
      } },
      history: async () => ({ text: 'Terminal command and tool output\nActual final reply' }),
    };
    const answer = await Manager.prototype.mobile.call(manager, 'fixture');
    assert.deepEqual(answer.messages, replies);
    assert.equal(answer.completed, 'one');
    assert.equal(answer.text, undefined);
    assert.equal(polls, 1);
    const full = await Manager.prototype.mobile.call(manager, 'fixture', true);
    assert.match(full.text, /Terminal command and tool output/);
    assert.equal(polls, 1, 'Full view does not wait on dialogue discovery');
  });

  test(`${platform} keeps the final terminal reply readable when Codex dialogue is unavailable`, async () => {
    for (const session of [
      { shell: 'codex', activity: { available: false } },
      { shell: 'bash', activity: { detected: true, available: false } },
    ]) {
      let captures = 0;
      const manager = {
        ensurePane: async () => {}, getSession: () => session,
        activity: { messages: () => null, inputReceipts: () => [] },
        history: async () => { captures++; return { text: 'Terminal command and tool output\nFinal reply remains readable.' }; },
      };
      const answer = await Manager.prototype.mobile.call(manager, 'fixture');
      assert.equal(answer.messages, undefined);
      assert.equal(answer.completed, null);
      assert.match(answer.text, /Final reply remains readable/);
      assert.equal(captures, 1, 'Missing structured dialogue must not hide available output');
      const full = await Manager.prototype.mobile.call(manager, 'fixture', true);
      assert.equal(full.text, answer.text);
      assert.equal(captures, 2);
    }
  });

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

test('source warm-up is bounded and shutdown releases pending answer readers', async t => {
  const session = { name: 'fixture', status: 'running', shell: 'codex', activity: { available: false } };
  const activity = new CodexActivity({ sessions: new Map([[session.name, session]]), emit() {}, serialize: s => s }, { interval: 60000 });
  t.after(() => activity.close()); clearInterval(activity.timer);
  let polls = 0; activity.poll = async () => { polls++; };
  await activity.ready(session.name, 20);
  assert.equal(polls, 1, 'Unresolvable identity does not create a polling loop');
  const pending = activity.ready(session.name, 4000);
  await new Promise(resolve => setImmediate(resolve));
  activity.close(); await pending;
  assert.equal(polls, 2);
});

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
