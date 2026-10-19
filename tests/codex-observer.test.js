const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectRollout, daemonPeers, terminalStatus, resolveRollout } = require('../server/services/codex-observer');
const candidate = (id, name, source = 'cli', cwd = '/work/project') => ({ path: id, name, meta: { id, cwd, source } });

test('standalone excludes subagents and shared daemon requires unique full current title', () => {
  const root = candidate('root', '当前工作');
  const child = candidate('child', '当前工作', { subagent: { thread_spawn: { parent_thread_id: 'root' } } });
  assert.equal(selectRollout([child, root], '', false), root);
  assert.equal(selectRollout([root, child], '⠦ 当前工作 | project', true), root);
  assert.equal(selectRollout([root], '', true), null, 'A lone shared-daemon thread may belong to another terminal');
  assert.equal(selectRollout([root], '其他工作 | project', true), null);
  assert.equal(selectRollout([root, candidate('same', '当前工作')], '当前工作 | project', true), null);
  assert.equal(selectRollout([root], '当前工作 | different-project', true), null);
  assert.equal(selectRollout([child], '当前工作 | project', false), null);
});

test('unix socket peers bind only a client actually connected to the managed daemon endpoint', () => {
  const rows = [
    'u_str ESTAB 0 0 * 100 * 101 users:(("codex",pid=10,fd=35))',
    'u_str ESTAB 0 0 /tmp/codex-daemon-1000/socket 101 * 100 users:(("codex",pid=20,fd=66))',
    'u_str ESTAB 0 0 * 102 * 103 users:(("codex",pid=11,fd=8))',
    'u_str ESTAB 0 0 * 103 * 102 users:(("codex",pid=11,fd=9))',
    'u_str ESTAB 0 0 * 104 * 105 users:(("other",pid=12,fd=1))',
    'u_str ESTAB 0 0 /tmp/unrelated 105 * 104 users:(("other",pid=30,fd=1))',
  ].join('\n');
  assert.deepEqual([...daemonPeers(rows)], [['10', '20']]);
});

test('default Codex titles truncate thread and project names without losing identity', () => {
  const name = '修复'.repeat(25), project = 'a-project-directory-name-longer-than-24';
  const root = candidate('root', name, 'cli', '/work/' + project);
  const displayed = '修复'.repeat(22) + '修... | a-project-directory-n...';
  assert.equal(selectRollout([root], displayed, true), root);
  assert.equal(selectRollout([root], '⠋ ' + displayed, true), root);
  assert.equal(selectRollout([root], '[ ! ] Action Required | ' + displayed, true), root);
  assert.equal(selectRollout([root, candidate('duplicate', name + '二', 'cli', '/work/' + project)], displayed, true), null,
    'Truncation collisions must not mix two conversations');
});

test('shared title uses the project root when Codex starts in a nested directory', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-title-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project'), cwd = path.join(project, 'src', 'nested');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(project, '.git'));
  await fs.mkdir(path.join(dir, 'sessions', 'today'), { recursive: true });
  const file = path.join(dir, 'sessions', 'today', 'rollout-one.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'one', source: 'cli', cwd } }) + '\n');
  const dbfile = path.join(dir, 'state_5.sqlite'), db = new DatabaseSync(dbfile);
  db.exec('CREATE TABLE threads (id TEXT, name TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('one', '项目子目录任务'); db.close();
  assert.equal(await resolveRollout([file, dbfile], '项目子目录任务 | project', true), file);
  assert.equal(await resolveRollout([file, dbfile], '项目子目录任务 | unrelated', true), null);
});

test('action-required title animation keeps the same thread bound without relaxing identity checks', () => {
  const root = candidate('root', '当前工作');
  const other = candidate('other', '其他工作');
  const child = candidate('child', '当前工作', { subagent: { thread_spawn: { parent_thread_id: 'root' } } });
  for (const prefix of ['[ ! ] Action Required | ', '[ . ] Action Required | ']) {
    const title = prefix + '当前工作 | project';
    assert.equal(selectRollout([root, other, child], title, true), root);
    assert.equal(selectRollout([root, other], '● ' + title, true), root);
    assert.equal(selectRollout([root], prefix + '当前工作 | other-project', true), null);
    assert.equal(selectRollout([root], prefix + '其他工作 | project', true), null);
    assert.equal(selectRollout([root], prefix + '当前工作', true), null);
    assert.equal(selectRollout([root, candidate('duplicate', '当前工作')], title, true), null);
    const literal = candidate('literal', prefix + '当前工作');
    assert.equal(selectRollout([literal], title, true), literal, 'Literal names are preserved');
    assert.equal(selectRollout([root, literal], title, true), null, 'Do not choose between literal and decorated names');
  }
  assert.equal(selectRollout([root], '[ ! ] Custom Notice | 当前工作 | project', true), null);
  assert.equal(selectRollout([root], '自定义 | 当前工作 | project', true), null);
});

test('live footer detects work/approval/retry without treating mentions or silence as completion', () => {
  assert.equal(terminalStatus('• Working (1m 2s • esc to interrupt)\n\n› Ask Codex to do anything\n  GPT-6-Astra max'), 'working');
  assert.equal(terminalStatus('◦ Working (27h 05m 19s • esc to interrupt) · 1 background terminal running\n\n› Ask Codex to do anything'), 'working');
  assert.equal(terminalStatus('Would you like to run the following command?\n  $ npm test\n› 1. Yes, proceed\n  2. No\n  esc to cancel'), 'waiting');
  assert.equal(terminalStatus('• Reconnecting... 2/5\n› Ask Codex'), 'retrying');
  assert.equal(terminalStatus('The code prints Working (1m • esc to interrupt).\n› Ask Codex'), null);
  assert.equal(terminalStatus('• Working (1m • esc to interrupt)\n' + 'old output\n'.repeat(20) + '› Ask Codex'), null);
  assert.equal(terminalStatus('• All done\n› Ask Codex'), null);
});

test('shared daemon reads names only for verified open rollouts and fails closed on ambiguous metadata', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-daemon-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'sessions', 'today'), { recursive: true });
  const file = path.join(dir, 'sessions', 'today', 'rollout-one.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'one', source: 'vscode', cwd: '/work/project' } }) + '\n');
  const dbfile = path.join(dir, 'state_5.sqlite'), db = new DatabaseSync(dbfile);
  db.exec('CREATE TABLE threads (id TEXT, name TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('one', '当前工作'); db.close();
  assert.equal(await resolveRollout([file, dbfile], '⠇ 当前工作 | project', true), file);
  assert.equal(await resolveRollout([file, dbfile], '[ ! ] Action Required | 当前工作 | project', true), file);
  assert.equal(await resolveRollout([file, dbfile], '[ . ] Action Required | 当前工作 | project', true), file);
  assert.equal(await resolveRollout([dbfile], '当前工作 | project', true), null);
  assert.equal(await resolveRollout([file], '当前工作 | project', true), null);
});

test('one unreadable pane loses stale status while other panes continue to update', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { CodexActivity } = require('../server/services/codex-activity');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-poll-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'good.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'event_msg', timestamp: 'now', payload: { type: 'task_complete', turn_id: 'new' } }) + '\n');
  const bad = { name: 'bad', status: 'running', activity: { completed: 'old', busy: true } }, good = { name: 'good', status: 'running' };
  const manager = { sessions: new Map([[bad.name, bad], [good.name, good]]), emit() {}, serialize: s => s };
  const observer = { observe: async pid => { if (pid === 'bad') throw Error('gone'); return { path: file }; } };
  const activity = new CodexActivity(manager, { observer }); activity.close();
  await Promise.all([activity.update(bad, { pid: 'bad' }), activity.update(good, { pid: 'good' })]);
  assert.equal(bad.activity.phase, 'unknown'); assert.equal(bad.activity.completed, null);
  assert.equal(good.activity.phase, 'completed'); assert.equal(good.activity.completed, 'now:new');
  // Replacing/truncating a file under the same path must not retain its old end state.
  await fs.writeFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } }) + '\n');
  await activity.update(good, { pid: 'good' }); assert.equal(good.activity.busy, true); assert.equal(good.activity.completed, null);
});

test('a missing terminal footer cannot discard a verified dialogue or completed turn', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { CodexActivity } = require('../server/services/codex-activity');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-footer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const row = (type, payload) => JSON.stringify({ type, timestamp: 'now', payload }) + '\n';
  await fs.writeFile(file, row('event_msg', { type: 'task_started', turn_id: 'one' }) +
    row('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '正在检查' }] }));
  const session = { name: 'fixture', status: 'running' };
  const manager = { sessions: new Map([[session.name, session]]), emit() {}, serialize: s => s };
  const observer = { observe: async () => ({ detected: true, path: file }) };
  const activity = new CodexActivity(manager, { observer }); activity.close();
  const pane = { pid: 'fixture', id: '=__hub_missing_footer_fixture__' };
  await activity.update(session, pane);
  assert.equal(activity.messages(session.name)?.[0]?.text, '正在检查');
  assert.equal(session.activity.available, true);
  await fs.appendFile(file, row('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '这条最终回复必须在回答里显示' }] }) +
    row('event_msg', { type: 'task_complete', turn_id: 'one' }));
  await activity.update(session, pane);
  assert.equal(activity.messages(session.name).at(-1).text, '这条最终回复必须在回答里显示');
  assert.equal(session.activity.phase, 'completed');
});
