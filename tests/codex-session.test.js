const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const SessionManager = require('../server/services/session-manager');

test('Codex launcher loads interactive shell proxy settings before running the command', () => {
  const tmp = fs.mkdtempSync('/tmp/hub-codex-proxy-');
  const result = path.join(tmp, 'environment.json');
  const rcfile = path.join(tmp, 'bashrc');
  const manager = new SessionManager(19780, 19790);
  const originalPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(tmp, 'codex'), `#!${process.execPath}\n` +
      `require('fs').writeFileSync(process.env.HUB_PROXY_TEST_RESULT, JSON.stringify({args:process.argv.slice(2),ready:process.env.HUB_PROXY_TEST_READY||null,proxy:process.env.https_proxy||null}));\n`, { mode: 0o755 });
    fs.writeFileSync(rcfile, 'export HUB_PROXY_TEST_READY=loaded\nexport https_proxy=http://127.0.0.1:19799\n');
    process.env.PATH = tmp + path.delimiter + originalPath;
    const command = manager.resolveCommand('codex');
    process.env.PATH = originalPath;
    const env = { ...process.env, HUB_PROXY_TEST_RESULT: result };
    for (const key of Object.keys(env)) if (/proxy/i.test(key) && key !== 'HUB_PROXY_TEST_RESULT') delete env[key];
    const run = args => {
      execFileSync(command[0], ['--rcfile', rcfile, ...args], { env, input: '', timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] });
      return JSON.parse(fs.readFileSync(result, 'utf8'));
    };
    // Reproduce the regression with the old non-interactive launcher.
    const old = run(command.slice(1).map(arg => arg === '-ic' ? '-c' : arg));
    assert.equal(old.ready, null);
    assert.equal(old.proxy, null);
    const fixed = run(command.slice(1));
    assert.deepEqual(fixed, { args: ['--yolo'], ready: 'loaded', proxy: 'http://127.0.0.1:19799' });
  } finally {
    process.env.PATH = originalPath;
    manager.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

async function until(check) {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Codex fixture');
}
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Codex starts once with --yolo, survives clients and Hub restart, and exits to a shell', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync('/tmp/hub-codex-');
  const bin = path.join(tmp, 'bin with spaces');
  fs.mkdirSync(bin);
  const log = path.join(tmp, 'starts.jsonl');
  // Exercise real tmux/ttyd processes without starting a model or using credentials.
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\n` +
    `require('fs').appendFileSync(process.env.HUB_CODEX_TEST_LOG, JSON.stringify({args:process.argv.slice(2),pid:process.pid})+'\\n');\n` +
    `process.stdout.write('CODEX_FIXTURE_READY\\n');\n` +
    `process.stdin.resume(); process.stdin.on('data', data => { if(data.toString().includes('exit-fixture')) process.exit(0); });\n`, { mode: 0o755 });
  const ports = [await freePort(), await freePort()];
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMUX_TMPDIR: tmp,
    HUB_STATE_FILE: path.join(tmp, 'sessions.json'), HUB_CODEX_TEST_LOG: log,
    HOST: '127.0.0.1', PORT: String(await freePort()),
    TTYD_PORT_RANGE_START: String(Math.min(...ports)), TTYD_PORT_RANGE_END: String(Math.max(...ports)) };
  delete env.TMUX;
  const base = `http://127.0.0.1:${env.PORT}`;
  let child, terminal;
  const starts = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  async function api(suffix = '', body, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + '/api/sessions' + suffix, { method,
      headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert(response.ok, JSON.stringify(data));
    return data;
  }
  const tmux = (...args) => execFileSync('tmux', args, { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  async function start() {
    child = spawn(process.execPath, ['server/index.js'], { env, cwd: path.join(__dirname, '..'), stdio: 'ignore' });
    await until(async () => { try { return Boolean(await api()); } catch { return false; } });
  }
  async function stop() {
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; child = null;
  }
  try {
    await start();
    const types = (await api('/shells')).shells;
    assert.equal(types[0].id, 'codex');
    assert(types.some(s => s.id === 'bash'));
    const created = await api('', { name: '自动 Codex', shell: 'codex' });
    assert.equal(created.shell, 'codex');
    await until(() => starts().length === 1);
    assert.deepEqual(starts()[0].args, ['--yolo']);
    const pane = () => tmux('display-message', '-p', '-t', `=${created.name}:`, '#{pane_id}:#{pane_pid}');
    const originalPane = pane();
    const originalCodexPid = starts()[0].pid;
    const suffix = '/' + created.name;
    await Promise.all([api(suffix + '/mobile'), api(suffix + '/mobile?view=full')]);
    terminal = new WebSocket(base.replace('http:', 'ws:') + `/terminal/${created.name}/ws`, 'tty');
    let terminalOutput = '';
    terminal.on('message', data => { terminalOutput += data.toString(); });
    await once(terminal, 'open');
    terminal.send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }));
    await until(() => terminalOutput.includes('CODEX_FIXTURE_READY'));
    assert.equal(pane(), originalPane);
    assert.equal(starts().length, 1);
    terminal.terminate(); terminal = null;
    await stop(); await start();
    assert.equal((await api()).sessions.find(s => s.name === created.name).shell, 'codex');
    await api(suffix + '/mobile');
    assert.equal(pane(), originalPane);
    assert.equal(starts().length, 1);
    process.kill(originalCodexPid, 0);
    await api(suffix + '/input', { text: 'exit-fixture', key: 'Enter' });
    await until(() => tmux('display-message', '-p', '-t', `=${created.name}:`, '#{pane_current_command}') === 'bash');
    await api(suffix + '/input', { text: "printf '%s%s\\n' HUB_AFTER_ CODEX", key: 'Enter' });
    await until(async () => (await api(suffix + '/history')).text.includes('HUB_AFTER_CODEX'));
    await stop(); await start();
    await api(suffix + '/mobile?view=full');
    assert.equal(pane(), originalPane);
    assert.equal(starts().length, 1, 'Exiting and reconnecting must not relaunch Codex');
    const plain = await api('', { name: '普通 Bash', shell: 'bash' });
    await api('/' + plain.name + '/mobile');
    assert.equal(plain.shell, 'bash');
    assert.equal(starts().length, 1, 'An explicit Bash session must remain an ordinary terminal');
  } finally {
    terminal?.terminate();
    if (child) await stop();
    try { tmux('kill-server'); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
