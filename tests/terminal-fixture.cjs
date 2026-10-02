const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await pause(25); }
  throw new Error('Terminal condition timed out');
}
async function port() {
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
}

async function fixture() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hub-terminal-'));
  const env = { ...process.env, TMUX_TMPDIR: tmp, HOST: '127.0.0.1', PORT: String(await port()),
    TTYD_PORT_RANGE_START: String(await port()) };
  env.TTYD_PORT_RANGE_END = env.TTYD_PORT_RANGE_START;
  delete env.TMUX;
  const root = path.resolve(__dirname, '..');
  const base = `http://127.0.0.1:${env.PORT}`;
  let errors = '';
  const child = spawn(process.execPath, ['server/index.js'], { env, cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', data => { errors += data; });
  const tm = (...args) => execFileSync('tmux', args, { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trimEnd();
  async function api(url = '', method = 'GET', data) {
    const response = await fetch(base + '/api/sessions' + url, { method,
      headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!response.ok) throw new Error(`Test API: ${response.status}`);
    return response.json();
  }
  const cleanup = async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    try { tm('kill-server'); } catch {}
    rmSync(tmp, { recursive: true, force: true });
    if (errors) throw new Error(errors);
  };
  try {
    await until(async () => { try { return Boolean(await api()); } catch { return false; } });
    const session = await api('', 'POST', { name: 'scroll-test', shell: 'bash' });
    // Only this private tmux server and synthetic content are ever used.
    const inputFile = path.join(tmp, 'input');
    const program = path.join(tmp, 'reader.py');
    writeFileSync(program, `import os, tty\ntty.setraw(0)\nwith open(${JSON.stringify(inputFile)}, 'wb', buffering=0) as f:\n while True:\n  data=os.read(0, 65536)\n  if not data: break\n  f.write(data)\n`);
    tm('new-session', '-d', '-s', session.name, '-x', '100', '-y', '30', 'python3', program);
    await until(() => existsSync(inputFile));
    const target = `=${session.name}:`;
    const tty = tm('display-message', '-p', '-t', target, '#{pane_tty}');
    const pid = tm('display-message', '-p', '-t', target, '#{pane_pid}');
    return { base, session, env, tmp, tm, target, pid, api, child, cleanup,
      input: () => readFileSync(inputFile), output: text => writeFileSync(tty, text) };
  } catch (error) { await cleanup(); throw error; }
}
module.exports = { fixture, until, pause };
