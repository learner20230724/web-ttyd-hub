const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { listProjects } = require('../server/services/codex-projects');
const SessionState = require('../server/services/session-state');

test('Codex project picker uses names/order/selection, deduplicates and filters missing folders', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-projects-'));
  try {
    const a = path.join(tmp, '中文 项目'), b = path.join(tmp, "quote's project");
    fs.mkdirSync(a); fs.mkdirSync(b);
    const file = path.join(tmp, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ 'local-projects': { a: { name: '中文', rootPaths: [a] }, b: { name: '第二个', rootPaths: [b] }, missing: { rootPaths: [path.join(tmp, 'missing')] } },
      'project-order': ['b', 'a'], 'selected-project': { type: 'local', projectId: 'a' }, 'electron-saved-workspace-roots': [a, b] }));
    const result = listProjects(file);
    assert.equal(result.projects.length, 2); assert.equal(result.projects[0].path, b);
    assert.equal(result.projects[1].active, true); assert.equal(result.projects[1].name, '中文');
    fs.writeFileSync(file, '{broken'); assert.equal(listProjects(file).projects.length, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Windows PowerShell and Codex working directories round trip in session state', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-state-'));
  try {
    const state = new SessionState(path.join(tmp, 'sessions.json'));
    state.save([{ name: 'win-test', displayName: '中文项目', shell: 'powershell', cwd: tmp, status: 'running', createdAt: new Date().toISOString() }]);
    assert.equal(state.read()[0].cwd, tmp); assert.equal(state.read()[0].shell, 'powershell');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
