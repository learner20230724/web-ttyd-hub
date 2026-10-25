const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodexActivity } = require('../server/services/codex-activity');
const SessionManager = require('../server/services/session-manager');

const stamp = '2026-10-25T00:00:00Z';
const row = (type, payload) => JSON.stringify({ type, timestamp: stamp, payload }) + '\n';
const reply = (text, phase = 'commentary') => row('response_item', {
  type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }],
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-content-revision-'));
  const filename = path.join(directory, 'rollout.jsonl');
  await fs.writeFile(filename, row('event_msg', { type: 'task_started', turn_id: 'one' }) + reply('Earlier progress') +
    row('event_msg', { type: 'task_complete', turn_id: 'one' }));
  const session = { name: 'fixture', createdAt: 'generation-one', shell: 'codex', status: 'running' };
  const notifications = [];
  const manager = {
    sessions: new Map([[session.name, session]]),
    emit(event, value) { if (event === 'session:activity') notifications.push(structuredClone(value.activity)); },
    serialize: value => value,
    getSession(name) { return this.sessions.get(name); },
    ensurePane: async () => {},
    history: async () => ({ text: 'Current full terminal output' }),
  };
  const activity = manager.activity = new CodexActivity(manager, {
    observer: { observe: async () => ({ detected: true, path: filename }) }, interval: 60000,
  });
  clearInterval(activity.timer);
  t.after(async () => { activity.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const update = () => activity.update(manager.getSession(session.name), { pid: 'synthetic', id: '=__hub_no_terminal__' });
  await update();
  return { manager, activity, session, filename, notifications, update };
}

for (const [platform, Manager] of [
  ['Linux', SessionManager],
  ['Windows', require('../server/services/windows-session-manager')],
]) {
test(platform + ': ' + 'a final reply arriving after completion publishes a new content revision without another turn or input', async t => {
  const f = await fixture(t);
  const first = await Manager.prototype.mobile.call(f.manager, f.session.name);
  const completed = f.session.activity.completed, notifications = f.notifications.length;
  assert.equal(first.messages.at(-1).text, 'Earlier progress');
  await fs.appendFile(f.filename, reply('The complete final answer', 'final_answer'));
  await f.update();
  assert.equal(f.notifications.length, notifications + 1,
    'An unchanged completed task must still notify clients when its final dialogue arrives');
  assert.equal(f.session.activity.completed, completed);
  assert.match(f.session.activity.contentRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(f.session.activity.contentRevision, first.contentRevision);
  const current = await Manager.prototype.mobile.call(f.manager, f.session.name);
  assert.equal(current.messages.at(-1).text, 'The complete final answer');
  assert.equal(current.contentRevision, f.session.activity.contentRevision);
  assert.equal(current.completed, completed);
  assert.equal(JSON.stringify(f.session.activity).includes(f.filename), false, 'A content revision must not expose its source path');
  const stable = f.session.activity.contentRevision, stableCount = f.notifications.length;
  await f.update();
  assert.equal(f.session.activity.contentRevision, stable, 'Reading the same file cannot manufacture new revisions');
  assert.equal(f.notifications.length, stableCount);
});

test(platform + ': ' + 'answer requests use one published dialogue/completion/revision snapshot rather than in-flight parser state', async t => {
  const f = await fixture(t);
  const first = await Manager.prototype.mobile.call(f.manager, f.session.name);
  const state = f.activity.states.get(f.session.name);
  // A stream chunk can mutate parser state before updateState finishes reading
  // and publishing. HTTP must keep serving the last committed snapshot.
  state.messages.push({ id: 'not-yet-published', role: 'assistant', phase: 'final_answer', text: 'Uncommitted text' });
  const during = await Manager.prototype.mobile.call(f.manager, f.session.name);
  assert.equal(during.messages.some(message => message.id === 'not-yet-published'), false);
  assert.equal(first.messages.some(message => message.id === 'not-yet-published'), false, 'Previously returned arrays must not mutate either');
  assert.equal(during.contentRevision, first.contentRevision);
  assert.equal(during.completed, first.completed);
  f.activity.publish(f.session, { ...f.session.activity });
  const after = await Manager.prototype.mobile.call(f.manager, f.session.name);
  assert.equal(after.messages.at(-1).text, 'Uncommitted text');
  assert.notEqual(after.contentRevision, first.contentRevision);
});

test(platform + ': ' + 'full captures keep the published completion and content revision from before asynchronous capture', async t => {
  const f = await fixture(t);
  const before = await Manager.prototype.mobile.call(f.manager, f.session.name);
  f.manager.history = async () => {
    await fs.appendFile(f.filename, reply('Late final answer', 'final_answer'));
    await f.update();
    return { text: 'Full output captured during an update' };
  };
  const full = await Manager.prototype.mobile.call(f.manager, f.session.name, true);
  assert.equal(full.completed, before.completed);
  assert.equal(full.contentRevision, before.contentRevision);
  assert.notEqual(f.session.activity.contentRevision, full.contentRevision);
});

test(platform + ': ' + 'accepted question receipts change the revision even when phase and messages are unchanged', async t => {
  const f = await fixture(t), count = f.notifications.length;
  const before = await Manager.prototype.mobile.call(f.manager, f.session.name);
  await fs.appendFile(f.filename,
    row('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'question' }) +
    row('response_item', { type: 'function_call_output', call_id: 'question', output: JSON.stringify({ answers: { q: { answers: ['Accepted reply'] } } }) }));
  await f.update();
  const after = await Manager.prototype.mobile.call(f.manager, f.session.name);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.completed, before.completed);
  assert.equal(f.notifications.length, count + 1);
  assert.notEqual(after.contentRevision, before.contentRevision);
  assert.equal(after.inputReceipts[0].text, 'Accepted reply');
});

test(platform + ': ' + 'a published dialogue cannot be returned for a replacement session with the same name', async t => {
  const f = await fixture(t);
  f.manager.sessions.set(f.session.name, { ...f.session, createdAt: 'generation-two' });
  f.activity.ready = async () => {};
  const result = await Manager.prototype.mobile.call(f.manager, f.session.name);
  assert.equal(result.messages, undefined);
  assert.equal(result.completed, null);
  assert.equal(result.contentRevision, null);
});

}
