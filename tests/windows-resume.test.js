const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const WindowsSessionManager = require('../server/services/windows-session-manager');

test('Real Windows ConPTY resumes in the selected directory and survives a Hub adapter restart', {
  skip: process.platform !== 'win32' ? 'Requires Windows ConPTY' : false, timeout: 45000,
}, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-windows-resume-'));
  const project = path.join(tmp, "中文 project's folder");
  const home = path.join(tmp, 'codex-home');
  const stateFile = path.join(tmp, 'sessions.json'), log = path.join(tmp, 'launch.json');
  const fake = path.join(tmp, 'fake-codex.ps1');
  const id = '01900000-0000-7000-8000-000000000001';
  fs.mkdirSync(project); fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: project, source: 'cli' } }) + '\n');
  fs.writeFileSync(fake, "$record=@{args=@($args);cwd=(Get-Location).Path}; $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:HUB_CODEX_TEST_LOG -Encoding UTF8; Write-Output 'WINDOWS_RESUME_FIXTURE_READY'; while($true){Start-Sleep -Seconds 1}");
  const changes = { CODEX_HOME: home, HUB_CODEX_EXE: fake, HUB_CODEX_TEST_LOG: log, HUB_CWD: project };
  const previous = Object.fromEntries(Object.keys(changes).map(k => [k, process.env[k]]));
  Object.assign(process.env, changes);
  let manager, session;
  const until = async fn => {
    for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Timed out waiting for Windows Codex fixture');
  };
  try {
    manager = new WindowsSessionManager(19800, 19810, stateFile);
    session = await manager.create('Windows resume test', 'codex', project, id);
    await until(() => fs.existsSync(log));
    const launched = JSON.parse(fs.readFileSync(log, 'utf8').replace(/^\uFEFF/, '').trim());
    assert.deepEqual(launched.args, ['resume', id, '--yolo']);
    // Windows runners can supply TEMP in 8.3 form; PowerShell expands it.
    assert.equal(fs.realpathSync.native(launched.cwd).toLowerCase(), fs.realpathSync.native(project).toLowerCase());
    await until(async () => (await manager.history(session.name)).text.includes('WINDOWS_RESUME_FIXTURE_READY'));
    const originalPid = session.pid;
    manager.cleanup();
    manager = new WindowsSessionManager(19800, 19810, stateFile);
    await manager.restore();
    assert.equal(manager.getSession(session.name).pid, originalPid);
    assert.equal(manager.getSession(session.name).resumeThreadId, id);
    manager.stop(session.name); await manager.restart(session.name);
    assert.equal(manager.getSession(session.name).pid, originalPid);
  } finally {
    if (manager && session) await manager.remove(session.name).catch(() => {});
    manager?.cleanup();
    await new Promise(resolve => setTimeout(resolve, 500));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
