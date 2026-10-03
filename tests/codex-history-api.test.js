const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const express = require('express');
const routes = require('../server/routes/sessions');
const SessionManager = require('../server/services/session-manager');
const { launchOptions } = require('../server/services/codex-launch');
const id = n => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

test('Project/history API supports search, pagination, previews, resume validation and duplicate-open protection', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-history-api-'));
  const home = path.join(tmp, 'codex'), project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true }); fs.mkdirSync(project);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; fs.rmSync(tmp, { recursive: true, force: true }); });
  for (let i = 1; i <= 55; i++) {
    fs.writeFileSync(path.join(home, 'sessions', `rollout-${id(i)}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: id(i), cwd: project, source: 'cli' } }) + '\n');
  }
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: id(1), thread_name: 'Find this 中文会话' }) + '\n');
  const sessions = [], calls = [];
  const manager = {
    getShells: () => [{ id: 'codex', name: 'Codex' }], list: () => sessions,
    getSession: name => sessions.find(x => x.name === name), serialize: x => ({ ...x }),
    restoreArchived(name) { delete this.getSession(name).archivedAt; delete this.getSession(name).expiresAt; },
    async restart(name) { this.getSession(name).status = 'running'; },
    async create(name, shell, cwd, resumeThreadId) {
      await launchOptions(shell, cwd, resumeThreadId);
      calls.push({ name, shell, cwd, resumeThreadId });
      await new Promise(resolve => setTimeout(resolve, 10));
      const s = { name: 'created-' + calls.length, shell, cwd, resumeThreadId, codexThreadId: resumeThreadId, status: 'running' };
      sessions.push(s); return s;
    },
  };
  const app = express(); app.use(express.json()); app.use('/api/sessions', routes(manager));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/sessions`;
  async function request(suffix = '', body) {
    const r = await fetch(base + suffix, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: r.status, data: await r.json(), cache: r.headers.get('cache-control') };
  }
  assert.ok((await request('/projects')).data.projects.some(x => x.path === project && x.sessionCount === 55));
  const query = '?cwd=' + encodeURIComponent(project);
  const first = await request('/codex-history' + query);
  assert.equal(first.status, 200); assert.equal(first.data.sessions.length, 50); assert.equal(first.data.nextOffset, 50);
  assert.equal(first.cache, 'no-store'); assert.doesNotMatch(JSON.stringify(first.data), /rolloutPath/);
  const last = await request('/codex-history' + query + '&offset=50');
  assert.equal(last.data.sessions.length, 5); assert.equal(last.data.nextOffset, null);
  const search = await request('/codex-history' + query + '&q=' + encodeURIComponent('中文'));
  assert.equal(search.data.total, 1); assert.equal(search.data.sessions[0].id, id(1));
  assert.equal((await request('/codex-history' + query + '&offset=-1')).status, 400);
  assert.equal((await request('/codex-history/' + id(1) + query)).status, 200);
  assert.equal((await request('/codex-history/' + id(1) + '?cwd=unknown')).status, 400);
  const body = { shell: 'codex', cwd: project, resumeThreadId: id(1) };
  const opened = await Promise.all([request('', body), request('', body)]);
  assert.equal(calls.length, 1); assert.equal(opened[0].data.name, opened[1].data.name);
  assert.equal((await request('/codex-history' + query + '&q=' + id(1))).data.sessions[0].hubSession.name, opened[0].data.name);
  sessions[0].status = 'stopped'; sessions[0].archivedAt = new Date().toISOString(); sessions[0].expiresAt = new Date(Date.now() + 10000).toISOString();
  assert.equal((await request('', body)).data.status, 'running'); assert.equal(calls.length, 1);
  assert.equal((await request('', { ...body, resumeThreadId: '../../bad' })).status, 400);
  assert.equal((await request('', { ...body, resumeThreadId: id(99) })).status, 400);
  assert.equal((await request('', { ...body, shell: 'bash' })).status, 400);
});

test('Linux launch commands keep UUID arguments separate from executable and shell paths', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-linux-command-'));
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(tmp, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(tmp, 'codex'), '', { mode: 0o755 });
  process.env.PATH = tmp;
  const manager = { shells: [{ id: 'bash', path: '/bin/bash' }] };
  const command = SessionManager.prototype.resolveCommand.call(manager, 'codex', id(1));
  assert.deepEqual(command.slice(-3), ['resume', id(1), '--yolo']);
  assert.equal(command[4], path.join(tmp, 'codex'));
  assert.doesNotMatch(command[2], new RegExp(id(1)));
  assert.throws(() => SessionManager.prototype.resolveCommand.call(manager, 'codex', 'bad;echo hi'));
});
