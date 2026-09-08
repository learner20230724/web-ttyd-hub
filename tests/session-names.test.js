const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const WebSocket = require('ws');
const SessionManager = require('../server/services/session-manager');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await pause(50);
  }
  throw new Error('Timed out waiting for condition');
}

async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}

test('Unicode labels validate, normalize and reject duplicates or malformed input', () => {
  const manager = new SessionManager(19000, 19010);
  assert.equal(manager.validateDisplayName('  中文会话 🚀  '), '中文会话 🚀');
  assert.equal(manager.validateDisplayName('e\u0301'), 'é');
  for (const value of ['', '   ', null, 12, {}, 'a\nb', 'a\u202Eb', '中'.repeat(81)]) {
    assert.throws(() => manager.validateDisplayName(value));
  }
  assert.equal(manager.validateDisplayName('中'.repeat(80)).length, 80);
  manager.sessions.set('legacy', { name: 'legacy', displayName: '中文' });
  assert.throws(() => manager.validateDisplayName('中文'));
  assert.equal(manager.validateDisplayName('中文', 'legacy'), '中文');
});

test('Chinese creation and rename preserve the live terminal, broadcast, and lifecycle', { timeout: 30000 }, async () => {
  // A private tmux socket directory prevents tests from touching user sessions.
  const tmp = mkdtempSync(path.join(tmpdir(), 'hub-names-'));
  const env = { ...process.env, TMUX_TMPDIR: tmp, HOST: '127.0.0.1', PORT: String(await freePort()),
    TTYD_PORT_RANGE_START: String(await freePort()) };
  env.TTYD_PORT_RANGE_END = env.TTYD_PORT_RANGE_START;
  delete env.TMUX;
  const child = spawn(process.execPath, ['server/index.js'], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${env.PORT}`;
  let terminal, events;
  async function api(url, method = 'GET', body) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  }
  try {
    await until(async () => { try { return (await api('/api/sessions')).status === 200; } catch { return false; } });
    events = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    const messages = [];
    events.on('message', data => messages.push(JSON.parse(data)));
    await once(events, 'open');
    const created = await api('/api/sessions', 'POST', { name: '中文 开发 🚀', shell: 'bash' });
    assert.equal(created.status, 201);
    const session = created.data;
    assert.equal(session.displayName, '中文 开发 🚀');
    assert.match(session.name, /^session-[a-f0-9-]+$/);
    const url = `/api/sessions/${session.name}`;
    const terminalUrl = `/terminal/${session.name}`;
    assert.equal((await fetch(base + terminalUrl + '/')).status, 200);
    terminal = new WebSocket(base.replace('http:', 'ws:') + terminalUrl + '/ws', 'tty');
    let output = '';
    terminal.on('message', data => { output += data.toString();  });
    await once(terminal, 'open');
    terminal.send(Buffer.from(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 })));
    let panePid;
    await until(() => {
      try { panePid = execFileSync('tmux', ['display-message', '-p', '-t', `=${session.name}:`, '#{pane_pid}'], { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); return !!panePid; }
      catch { return false; }
    });
    const renamed = await api(url, 'PATCH', { name: '排查 日志 / 第二轮' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.displayName, '排查 日志 / 第二轮');
    assert.equal(renamed.data.name, session.name);
    assert.equal(renamed.data.pid, session.pid);
    assert.equal(renamed.data.port, session.port);
    assert.equal(execFileSync('tmux', ['display-message', '-p', '-t', `=${session.name}:`, '#{pane_pid}'], { env }).toString().trim(), panePid);
    await until(() => messages.some(m => m.event === 'session:renamed' && m.data.displayName === '排查 日志 / 第二轮'));
    assert.equal(terminal.readyState, WebSocket.OPEN);
    terminal.send(Buffer.from("0printf '%s%s\\n' HUB_RENAME_ STILL_ALIVE\r"));
    await until(() => output.includes('HUB_RENAME_STILL_ALIVE'));
    assert.equal((await api(url, 'PATCH', { name: '   ' })).status, 400);
    assert.equal((await api('/api/sessions', 'POST', { name: '排查 日志 / 第二轮' })).status, 400);
    assert.equal((await api(url, 'PATCH', { name: '排查 日志 / 第二轮' })).status, 200);
    assert.equal((await api(url + '/stop', 'POST', {})).status, 200);
    await pause(150);
    assert.equal((await api(url, 'PATCH', { name: '已停止的中文会话' })).status, 200);
    assert.equal((await api(url + '/restart', 'POST', {})).data.displayName, '已停止的中文会话');
    assert.equal((await api(url, 'DELETE')).status, 200);
    await pause(150);
    const legacy = await api('/api/sessions', 'POST', { name: 'legacy-name', shell: 'bash' });
    assert.equal(legacy.status, 201);
    assert.equal(legacy.data.name, 'legacy-name');
    assert.equal((await api('/api/sessions/legacy-name', 'PATCH', { name: '旧会话中文名' })).status, 200);
    assert.equal((await api('/api/sessions/legacy-name', 'DELETE')).status, 200);
  } finally {
    terminal?.terminate();
    events?.terminate();
    child.kill('SIGTERM');
    await once(child, 'exit');
    try { execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore' }); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
});
