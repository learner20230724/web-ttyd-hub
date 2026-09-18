const { spawn, execFile, execFileSync } = require('child_process');
const net = require('net');
const { promisify, stripVTControlCharacters } = require('util');
const runFile = promisify(execFile);
const { randomUUID } = require('crypto');
const EventEmitter = require('events');
const PortManager = require('./port-manager');
const { CodexActivity } = require('./codex-activity');

const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const KNOWN_SHELLS = [
  { id: 'bash', name: 'Bash', paths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'] },
  { id: 'zsh', name: 'Zsh', paths: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'] },
  { id: 'fish', name: 'Fish', paths: ['/usr/local/bin/fish', '/opt/homebrew/bin/fish', '/usr/bin/fish'] },
  { id: 'sh', name: 'Sh', paths: ['/bin/sh', '/usr/bin/sh'] },
];

const fs = require('fs');

function detectShells() {
  const available = [];
  for (const shell of KNOWN_SHELLS) {
    const found = shell.paths.find(p => fs.existsSync(p));
    if (found) {
      available.push({ id: shell.id, name: shell.name, path: found });
    }
  }
  return available;
}

const SPAWN_ENV = {
  ...process.env,
  PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ''}`
};

function waitForPort(port, host = '127.0.0.1', timeout = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      if (Date.now() - start > timeout) {
        return reject(new Error(`ttyd did not start within ${timeout}ms`));
      }
      const sock = net.createConnection({ port, host }, () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', () => {
        setTimeout(tryConnect, 100);
      });
    }
    tryConnect();
  });
}

class SessionManager extends EventEmitter {
  constructor(portRangeStart, portRangeEnd, stateFile = null) {
    super();
    this.sessions = new Map();
    this.portManager = new PortManager(portRangeStart, portRangeEnd);
    this.shells = detectShells();
    this.nameCounter = 0;
    this.activity = new CodexActivity(this);
    this.inputQueues = new Map();
    this.state = stateFile ? new (require('./session-state'))(stateFile) : null;
    this.restoring = false;
    this.closing = false;
    this.archiveSweep = setInterval(() => { if (!this.restoring && !this.closing) this.purgeExpired().catch(err => console.error('Archive cleanup failed:', err.message)); }, 1000);
    this.archiveSweep.unref();
    for (const event of ['session:created', 'session:renamed', 'session:stopped', 'session:deleted', 'session:exited', 'session:identity', 'session:archived', 'session:restored']) {
      this.on(event, () => { if (this.state && !this.restoring && !this.closing) this.state.save(this.list()); });
    }
  }

  async restore() {
    if (!this.state) return;
    const records = this.state.read();
    this.restoring = true;
    try {
      for (const saved of records) {
        this.sessions.set(saved.name, { name: saved.name, displayName: saved.displayName,
          shell: saved.shell, createdAt: saved.createdAt, archivedAt: saved.archivedAt || null, expiresAt: saved.expiresAt || null, codexThreadId: saved.codexThreadId || null,
          status: 'stopped', port: null, pid: null, process: null });
      }
      await this.purgeExpired();
      for (const saved of records) if (saved.status === 'running' && this.sessions.has(saved.name)) await this.restart(saved.name);
      this.state.save(this.list());
    } finally { this.restoring = false; }
  }

  generateName(shell) {
    const prefix = shell || 'session';
    this.nameCounter++;
    let name = `${prefix}-${this.nameCounter}`;
    while (this.sessions.has(name)) {
      this.nameCounter++;
      name = `${prefix}-${this.nameCounter}`;
    }
    return name;
  }

  getShells() {
    return this.shells;
  }

  resolveShell(shellId) {
    if (!shellId) return null;
    const shell = this.shells.find(s => s.id === shellId);
    if (!shell) throw new Error(`Shell "${shellId}" is not available`);
    return shell.path;
  }

  validateDisplayName(value, exceptName) {
    if (typeof value !== 'string') throw new Error('Session name must be text / 会话名称必须是文本');
    const displayName = value.trim().normalize('NFC');
    if (!displayName || Array.from(displayName).length > 80 || /[\p{Cc}\p{Cf}]/u.test(displayName)) {
      throw new Error('Use 1–80 characters without control characters / 请输入 1–80 个字符，不含控制字符');
    }
    for (const session of this.sessions.values()) {
      if (session.name !== exceptName && (session.displayName || session.name) === displayName) {
        throw new Error('Session name already exists / 会话名称已存在');
      }
    }
    return displayName;
  }

  rename(name, value) {
    const session = this.getSession(name);
    session.displayName = this.validateDisplayName(value, name);
    this.emit('session:renamed', this.serialize(session));
    return this.serialize(session);
  }

  async create(value, shell) {
    if (value == null || value === '') value = this.generateName(shell);
    const displayName = this.validateDisplayName(value);
    // Keep legacy ASCII IDs compatible; labels never enter shell commands or URLs.
    const name = SESSION_NAME_RE.test(displayName) && !this.sessions.has(displayName)
      ? displayName : `session-${randomUUID()}`;
    const shellPath = this.resolveShell(shell);
    const port = await this.portManager.allocate();

    const tmuxArgs = ['tmux', 'new', '-A', '-s', name];
    if (shellPath) tmuxArgs.push(shellPath);

    const proc = spawn('ttyd', [
      '-W', '-p', String(port),
      '-i', '127.0.0.1',
      '-b', `/terminal/${name}`,
      '-s', '9',
      '-t', 'theme={"background":"#000000"}',
      '-t', 'scrollback=10000',
      '-t', 'disableLeaveAlert=true',
      '-t', 'disableResizeOverlay=true',
      ...tmuxArgs
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: SPAWN_ENV
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk; });

    const session = {
      name,
      displayName,
      port,
      pid: proc.pid,
      shell: shell || null,
      status: 'running',
      createdAt: new Date().toISOString(),
      process: proc
    };

    proc.on('exit', (code) => {
      if (!this.closing && session.process === proc && session.status === 'running') {
        session.status = 'stopped';
        session.pid = null;
        session.process = null;
        this.portManager.release(port);
        session.port = null;
        this.emit('session:exited', this.serialize(session));
      }
    });

    // Wait for ttyd to be ready
    try {
      await waitForPort(port);
      this.validateDisplayName(displayName);
    } catch (err) {
      proc.kill('SIGTERM');
      this.portManager.release(port);
      throw new Error(`ttyd failed to start: ${stderrBuf.trim() || err.message}`);
    }

    this.sessions.set(name, session);
    this.emit('session:created', this.serialize(session));
    return this.serialize(session);
  }

  stop(name) {
    const session = this.getSession(name);
    if (session.status !== 'running') {
      throw new Error(`Session "${name}" is not running`);
    }
    session.process.kill('SIGTERM');
    session.status = 'stopped';
    session.pid = null;
    session.process = null;
    this.portManager.release(session.port);
    session.port = null;
    this.emit('session:stopped', this.serialize(session));
    return this.serialize(session);
  }

  archive(name) {
    const session = this.getSession(name);
    if (!session.archivedAt) {
      session.archivedAt = new Date().toISOString();
      session.expiresAt = new Date(Date.parse(session.archivedAt) + 30 * 60 * 1000).toISOString();
      this.emit('session:archived', this.serialize(session));
    }
    return this.serialize(session);
  }

  restoreArchived(name) {
    const session = this.getSession(name);
    if (!session.archivedAt) throw new Error('会话不在归档中');
    if (Date.parse(session.expiresAt) <= Date.now()) throw new Error('归档已到期');
    session.archivedAt = null;
    session.expiresAt = null;
    this.emit('session:restored', this.serialize(session));
    return this.serialize(session);
  }

  async purgeExpired(now = Date.now()) {
    for (const session of this.sessions.values()) {
      if (session.archivedAt && Date.parse(session.expiresAt) <= now) await this.remove(session.name);
    }
  }

  async remove(name) {
    const session = this.getSession(name);
    if (session.status === 'running') {
      session.process.kill('SIGTERM');
      this.portManager.release(session.port);
    }
    // Kill tmux session
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' });
    } catch (_) {
      // tmux session may not exist
    }
    this.sessions.delete(name);
    this.emit('session:deleted', { name });
    return { name };
  }

  async restart(name) {
    const session = this.getSession(name);
    if (session.status === 'running') {
      throw new Error(`Session "${name}" is already running`);
    }
    const shellPath = this.resolveShell(session.shell);
    const port = await this.portManager.allocate();

    const tmuxArgs = ['tmux', 'new', '-A', '-s', name];
    if (shellPath) tmuxArgs.push(shellPath);

    const proc = spawn('ttyd', [
      '-W', '-p', String(port),
      '-i', '127.0.0.1',
      '-b', `/terminal/${name}`,
      '-s', '9',
      '-t', 'theme={"background":"#000000"}',
      '-t', 'scrollback=10000',
      '-t', 'disableLeaveAlert=true',
      '-t', 'disableResizeOverlay=true',
      ...tmuxArgs
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: SPAWN_ENV
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk; });

    session.port = port;
    session.pid = proc.pid;
    session.status = 'running';
    session.process = proc;

    proc.on('exit', (code) => {
      if (!this.closing && session.process === proc && session.status === 'running') {
        session.status = 'stopped';
        session.pid = null;
        session.process = null;
        this.portManager.release(port);
        session.port = null;
        this.emit('session:exited', this.serialize(session));
      }
    });

    // Wait for ttyd to be ready
    try {
      await waitForPort(port);
    } catch (err) {
      proc.kill('SIGTERM');
      session.status = 'stopped';
      session.pid = null;
      session.process = null;
      this.portManager.release(port);
      session.port = null;
      throw new Error(`ttyd failed to start: ${stderrBuf.trim() || err.message}`);
    }

    this.emit('session:created', this.serialize(session));
    return this.serialize(session);
  }

  async ensurePane(name) {
    const session = this.getSession(name);
    if (session.status !== 'running') throw new Error('会话已停止');
    try { await runFile('tmux', ['has-session', '-t', `=${name}`]); }
    catch {
      const args = ['new-session', '-d', '-s', name, '-x', '120', '-y', '40'];
      const shell = this.resolveShell(session.shell);
      if (shell) args.push(shell);
      await runFile('tmux', args);
    }
  }

  async mobile(name) {
    await this.ensurePane(name);
    const messages = this.activity.messages(name);
    if (messages?.length) return { messages, activity: this.getSession(name).activity };
    return { ...await this.history(name), activity: this.getSession(name).activity };
  }

  input(name, { text, key }) {
    this.getSession(name);
    if (key != null && !['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'C-c'].includes(key)) throw new Error('Unsupported key');
    if (text != null && (typeof text !== 'string' || Buffer.byteLength(text) > 64000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text))) throw new Error('输入文字无效或超过 64 KB');
    const previous = this.inputQueues.get(name) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      await this.ensurePane(name);
      if (text) {
        const buffer = `hub-${randomUUID()}`;
        // stdin + named tmux buffer avoids shell interpolation and preserves multiline paste.
        await new Promise((resolve, reject) => {
          const child = spawn('tmux', ['load-buffer', '-b', buffer, '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
          child.on('error', reject); child.stdin.on('error', reject);
          child.on('close', code => code === 0 ? resolve() : reject(new Error('无法写入终端')));
          child.stdin.end(text);
        });
        try { await runFile('tmux', ['paste-buffer', '-d', '-p', '-b', buffer, '-t', `=${name}:`]); }
        finally { await runFile('tmux', ['delete-buffer', '-b', buffer]).catch(() => {}); }
        // Let bracketed-paste handling complete before submitting the input.
        if (key) await new Promise(resolve => setTimeout(resolve, 80));
      }
      if (key) await runFile('tmux', ['send-keys', '-t', `=${name}:`, key]);
      return { ok: true };
    });
    this.inputQueues.set(name, task);
    task.finally(() => { if (this.inputQueues.get(name) === task) this.inputQueues.delete(name); }).catch(() => {});
    return task;
  }

  async history(name) {
    const session = this.getSession(name);
    try {
      const { stdout } = await runFile('tmux', [
        'capture-pane', '-p', '-e', '-J', '-S', '-20000', '-t', `=${session.name}:`
      ], { env: SPAWN_ENV, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
      return { name: session.name, text: stripVTControlCharacters(stdout), ansi: stdout, capturedAt: new Date().toISOString() };
    } catch (_) {
      throw new Error('History is unavailable: the tmux pane may have exited / 暂无历史输出，终端可能尚未连接或已退出');
    }
  }

  getSession(name) {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session "${name}" not found`);
    }
    return session;
  }

  list() {
    return Array.from(this.sessions.values()).map(s => this.serialize(s));
  }

  serialize(session) {
    const { process: _, ...rest } = session;
    return rest;
  }

  cleanup() {
    this.closing = true;
    clearInterval(this.archiveSweep);
    this.activity.close();
    for (const session of this.sessions.values()) {
      if (session.status === 'running' && session.process) {
        session.process.kill('SIGTERM');
      }
    }
  }
}

module.exports = SessionManager;
