const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CodexHistory } = require('../server/services/codex-history');
const { getProjects, resolveProject } = require('../server/services/codex-projects');
const { codexArgs, launchOptions } = require('../server/services/codex-launch');
const SessionState = require('../server/services/session-state');
const id = n => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-history-'));
  const home = path.join(tmp, 'codex'), a = path.join(tmp, "中文 project's A"), b = path.join(tmp, 'B');
  for (const dir of [home, a, b]) fs.mkdirSync(dir);
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; fs.rmSync(tmp, { recursive: true, force: true }); });
  function rollout(n, cwd = a, extra = {}, events = [], folder = 'sessions') {
    const dir = path.join(home, folder, '2026', '10', '03'); fs.mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, `rollout-2026-10-03-${id(n)}.jsonl`);
    const meta = { type: 'session_meta', payload: { id: id(n), cwd, timestamp: '2026-10-03T00:00:00Z', source: 'cli', ...extra } };
    fs.writeFileSync(filename, [meta, ...events].map(JSON.stringify).join('\n') + '\n');
    return filename;
  }
  return { tmp, home, a, b, rollout };
}
const message = (role, text, channel) => ({ type: 'response_item', payload: {
  type: 'message', role, ...(channel ? { channel } : {}), content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
} });

test('CLI-only project discovery and fallback history work without Windows desktop metadata', async t => {
  const f = fixture(t);
  f.rollout(1); f.rollout(2, f.b); f.rollout(3, f.a, { source: { subagent: 'spawn' } });
  f.rollout(4, f.a, {}, [], 'archived_sessions');
  fs.writeFileSync(path.join(f.home, 'session_index.jsonl'), [
    JSON.stringify({ id: id(1), thread_name: '旧标题' }), 'partial invalid JSON',
    JSON.stringify({ id: id(1), thread_name: '修复项目 A' }),
  ].join('\n'));
  const history = new CodexHistory(f.home, { sqlite: false });
  const rows = await history.load();
  assert.equal(rows.length, 2); assert.equal(rows.find(x => x.id === id(1)).title, '修复项目 A');
  const projects = (await getProjects()).projects;
  assert.equal(projects.find(x => x.path === f.a).sessionCount, 1);
  assert.ok(projects.some(x => x.path === f.b));
  assert.equal(await resolveProject(f.a), f.a);
  await assert.rejects(resolveProject(path.join(f.tmp, 'unknown')), /请选择/);
  await assert.rejects(resolveProject('relative'), /请选择/);
  assert.equal((await launchOptions('codex', f.a, id(1))).resumeThreadId, id(1));
  await assert.rejects(launchOptions('codex', f.b, id(1)), /不属于/);
  await assert.rejects(launchOptions('bash', f.a, id(1)), /只有 Codex/);
  await assert.rejects(launchOptions('codex', undefined, id(1)), /必须选择项目/);
});

test('History preview exposes only user and final assistant text, never tools or metadata', async t => {
  const f = fixture(t);
  f.rollout(1, f.a, {}, [message('developer', 'SECRET'), message('user', '# AGENTS.md instructions\nSECRET'),
    message('user', '<environment_context>SECRET'), message('assistant', 'SECRET', 'analysis'),
    message('assistant', 'SECRET', 'summary'), message('tool', 'SECRET'),
    message('user', '问题 <script>alert(1)</script>'), message('assistant', '答案', 'final')]);
  const result = await new CodexHistory(f.home, { sqlite: false }).preview(f.a, id(1));
  assert.deepEqual(result.messages.map(x => x.role), ['user', 'assistant']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|rolloutPath/);
  assert.match(result.messages[0].text, /<script>/); // UI must render as text, not HTML.
});

test('Selected thread rejects mismatched projects, missing files and malformed IDs', async t => {
  const f = fixture(t), file = f.rollout(1);
  const history = new CodexHistory(f.home, { sqlite: false });
  await history.load();
  await assert.rejects(history.thread(f.b, id(1)), /不属于/);
  for (const bad of ['../../auth.json', "'; exit; '", {}, [id(1)]]) await assert.rejects(history.thread(f.a, bad), /无效/);
  fs.unlinkSync(file);
  await assert.rejects(history.thread(f.a, id(1)), /已移除/);
});

test('SQLite metadata is read-only; archived/agent sessions and outside rollout paths are rejected', async t => {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { t.skip('node:sqlite unavailable; fallback covered separately'); return; }
  const f = fixture(t), file = f.rollout(1);
  const database = path.join(f.home, 'state_5.sqlite');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT, title TEXT, archived INTEGER, source TEXT, updated_at INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(id(1), f.a, file, 'SQLite title', 0, 'cli', 1700000000);
  insert.run(id(2), f.a, file, 'Hidden archive', 1, 'cli', 1700000000);
  insert.run(id(3), f.a, file, 'Hidden subagent', 0, '{"subagent":{}}', 1700000000);
  const outside = path.join(f.tmp, 'outside.jsonl'); fs.copyFileSync(file, outside);
  insert.run(id(4), f.a, outside, 'Unsafe file', 0, 'cli', 1700000000);
  db.close();
  const before = fs.readFileSync(database);
  const history = new CodexHistory(f.home);
  assert.equal((await history.load()).length, 2);
  assert.equal((await history.thread(f.a, id(1))).title, 'SQLite title');
  await assert.rejects(history.thread(f.a, id(4)), /历史目录/);
  assert.deepEqual(fs.readFileSync(database), before);
});

test('Resume IDs round-trip in durable state and launch arguments are injection-safe', t => {
  const f = fixture(t);
  const state = new SessionState(path.join(f.tmp, 'state.json'));
  state.save([{ name: 'resume-test', displayName: 'Resume', shell: 'codex', cwd: f.a, resumeThreadId: id(1), codexThreadId: id(1), status: 'stopped', createdAt: new Date().toISOString() }]);
  assert.equal(state.read()[0].resumeThreadId, id(1));
  assert.deepEqual(codexArgs(id(1)), ['resume', id(1), '--yolo']);
  assert.deepEqual(codexArgs(), ['--yolo']);
  assert.throws(() => codexArgs('--last; touch /tmp/bad'));
  const invalid = JSON.parse(fs.readFileSync(state.filename)); invalid.sessions[0].resumeThreadId = [id(1)];
  fs.writeFileSync(state.filename, JSON.stringify(invalid));
  assert.throws(() => state.read(), /Invalid saved resume/);
});

test('Corrupt database and partial rollout lines do not prevent fallback or bounded previews', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'state_5.sqlite'), 'not sqlite');
  const events = [message('user', '首个真实问题'), ...Array.from({ length: 30 }, (_, i) => message('assistant', `answer ${i} ` + 'x'.repeat(20000)))];
  const file = f.rollout(1, f.a, {}, events);
  fs.appendFileSync(file, '{"partial":');
  const history = new CodexHistory(f.home);
  assert.equal((await history.load())[0].title, '首个真实问题');
  const result = await history.preview(f.a, id(1));
  assert.equal(result.truncated, true); assert.equal(result.messages.length, 12);
  assert.ok(result.messages.every(x => x.text.length <= 4000));
  assert.match(result.messages.at(-1).text, /^answer 29/);
});
