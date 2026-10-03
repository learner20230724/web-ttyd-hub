// Native Windows adapter. Each ConPTY is owned by a detached, authenticated
// loopback worker, so browser and Hub restarts do not terminate user programs.
const Base = require('./session-manager');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHmac } = require('node:crypto');
const { waitAfterPaste } = require('./paste-timing');

class WindowsSessionManager extends Base {
  constructor(start, end, stateFile) {
    super(start, end, stateFile);
    this.activity.close();
    this.workerDir = path.join(path.dirname(stateFile), 'workers');
    fs.mkdirSync(this.workerDir, { recursive: true });
    this.secretFile = path.join(this.workerDir, 'secret');
    if (!fs.existsSync(this.secretFile)) fs.writeFileSync(this.secretFile, randomUUID() + randomUUID(), { flag: 'wx', mode: 0o600 });
    this.workerSecret = fs.readFileSync(this.secretFile, 'utf8');
    this.shells = [{ id: 'powershell', name: 'Windows PowerShell', path: process.env.HUB_POWERSHELL || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }];
    this.activity = new (require('./codex-activity').CodexActivity)(this);
    this.healthTimer = setInterval(() => this.pollWorkers(), 3000);
    this.healthTimer.unref();
  }
  workerToken(name) { return createHmac('sha256', this.workerSecret).update(name).digest('hex'); }
  workerFile(name) { return path.join(this.workerDir, name + '.json'); }
  async call(session, route, body) {
    const r = await fetch(`http://127.0.0.1:${session.port}${route}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'x-hub-worker-token': this.workerToken(session.name), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Terminal worker failed');
    return data;
  }
  async attach(session) {
    try {
      const saved = JSON.parse(fs.readFileSync(this.workerFile(session.name), 'utf8'));
      const candidate = { ...session, port: saved.port };
      const health = await this.call(candidate, '/health');
      if (health.name !== session.name || !health.alive) return false;
      Object.assign(session, { port: saved.port, pid: health.pid, status: 'running', process: null });
      return true;
    } catch { return false; }
  }
  async launch(session) {
    if (await this.attach(session)) return;
    if (!['powershell', 'codex', null].includes(session.shell)) throw new Error('Windows supports PowerShell and Codex');
    const config = { name: session.name, token: this.workerToken(session.name),
      shell: this.shells[0].path, kind: session.shell,
      codexExe: process.env.HUB_CODEX_EXE || 'codex',
      resumeThreadId: session.resumeThreadId || null,
      cwd: session.cwd || process.env.HUB_CWD || process.env.USERPROFILE,
      base: process.env.HUB_BASE_PATH || '', stateFile: this.workerFile(session.name) };
    const child = spawn(process.execPath, [path.join(__dirname, 'windows-worker.js')], {
      detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: process.env
    });
    let failure;
    child.on('error', err => { failure = err; });
    child.stdin.on('error', err => { failure = err; });
    child.stdin.end(JSON.stringify(config));
    child.unref();
    for (let i = 0; i < 120; i++) {
      if (failure) throw failure;
      if (await this.attach(session)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Windows terminal did not become ready; check PowerShell/node-pty installation');
  }
  async create(value, shell = 'powershell', cwd, resumeThreadId) {
    const options = await require('./codex-launch').launchOptions(shell, cwd, resumeThreadId);
    if (this.sessions.size >= 40) throw new Error('最多创建 40 个会话，请清理已归档会话');
    if (value == null || value === '') value = this.generateName(shell);
    const displayName = this.validateDisplayName(value);
    const name = /^[a-zA-Z0-9_-]+$/.test(displayName) && !this.sessions.has(displayName) ? displayName : `session-${randomUUID()}`;
    const workingDirectory = options.cwd || process.env.HUB_CWD || process.env.USERPROFILE;
    const session = { name, displayName, shell, cwd: workingDirectory,
      ...(options.resumeThreadId ? { resumeThreadId: options.resumeThreadId, codexThreadId: options.resumeThreadId } : {}),
      status: 'stopped', createdAt: new Date().toISOString(), port: null, pid: null, process: null };
    this.sessions.set(name, session); // Reserve the name before awaiting a spawn.
    try { await this.launch(session); }
    catch (error) { this.sessions.delete(name); throw error; }
    this.emit('session:created', this.serialize(session));
    return this.serialize(session);
  }
  stop(name) {
    const session = this.getSession(name);
    if (session.status !== 'running') throw new Error('会话已停止');
    // Like stopping ttyd, detach access but keep the underlying program alive.
    session.status = 'stopped';
    this.call(session, '/detach', {}).catch(() => {});
    this.emit('session:stopped', this.serialize(session));
    return this.serialize(session);
  }
  async restart(name) {
    const session = this.getSession(name);
    if (session.status === 'running') throw new Error('会话已在运行');
    await this.launch(session);
    this.emit('session:created', this.serialize(session));
    return this.serialize(session);
  }
  async remove(name) {
    const session = this.getSession(name);
    // Reattach stopped entries to terminate their underlying worker, too.
    if (!session.port) await this.attach(session);
    if (session.port) await this.call(session, '/terminate', {}).catch(() => {});
    this.sessions.delete(name);
    try { fs.unlinkSync(this.workerFile(name)); } catch {}
    this.emit('session:deleted', { name });
    return { name };
  }
  async ensurePane(name) {
    if (this.getSession(name).status !== 'running') throw new Error('会话已停止');
  }
  async history(name) { return this.call(this.getSession(name), '/history'); }
  async mobile(name, full = false) {
    await this.ensurePane(name);
    const inputReceipts = this.activity.inputReceipts(name);
    if (!full) {
      const messages = this.activity.messages(name);
      if (messages?.length) return { messages, inputReceipts, activity: this.getSession(name).activity };
    }
    return { ...await this.history(name), inputReceipts, activity: this.getSession(name).activity };
  }
  input(name, { text, key }) {
    // Keep the fix in the Hub: already running ConPTY workers can keep their
    // terminals alive across this update, including workers from older versions.
    this.getSession(name);
    if (key != null && !['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'S-Left', 'Tab', 'C-c'].includes(key)) throw new Error('Unsupported key');
    const previous = this.inputQueues.get(name) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      await this.ensurePane(name);
      const session = this.getSession(name);
      if (text && key) {
        await this.call(session, '/input', { text });
        await waitAfterPaste(key);
        return this.call(session, '/input', { key });
      }
      return this.call(session, '/input', { text, key });
    });
    this.inputQueues.set(name, task);
    task.finally(() => { if (this.inputQueues.get(name) === task) this.inputQueues.delete(name); }).catch(() => {});
    return task;
  }
  async pollWorkers() {
    if (this.polling || this.closing || this.restoring) return;
    this.polling = true;
    try {
      for (const session of this.sessions.values()) if (session.status === 'running') {
        try {
          const result = await this.call(session, '/health');
          if (!result.alive) throw new Error('Shell exited');
        } catch {
          session.status = 'stopped'; session.pid = null;
          this.emit('session:exited', this.serialize(session));
        }
      }
    } finally { this.polling = false; }
  }
  cleanup() {
    this.closing = true;
    clearInterval(this.archiveSweep); clearInterval(this.healthTimer);
    this.activity.close();
    // Intentionally leave detached workers alive, analogous to tmux.
  }
}
module.exports = WindowsSessionManager;
