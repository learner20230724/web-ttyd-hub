const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { WebSocketServer } = require('ws');

const LIMIT = 16 * 1024 * 1024;
const fields = ['pane_id', 'pane_width', 'pane_height', 'history_size', 'cursor_x', 'cursor_y',
  'alternate_on', 'alternate_saved_x', 'alternate_saved_y', 'cursor_flag', 'insert_flag',
  'keypad_cursor_flag', 'keypad_flag', 'origin_flag', 'wrap_flag', 'mouse_all_flag',
  'mouse_button_flag', 'mouse_standard_flag', 'mouse_sgr_flag', 'mouse_utf8_flag',
  'scroll_region_upper', 'scroll_region_lower', 'pane_tabs'];

// Control-mode output and capture-pane -C use octal escapes. Decode bytes before
// UTF-8, including when a multibyte character crosses stdout/message boundaries.
function unescape(data) {
  const out = Buffer.allocUnsafe(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 92 && i + 3 < data.length && data.subarray(i + 1, i + 4).every(c => c >= 48 && c <= 55)) {
      out[n++] = parseInt(data.toString('ascii', i + 1, i + 4), 8); i += 3;
    } else if (data[i] === 92 && data[i + 1] === 92) {
      out[n++] = 92; i++;
    } else out[n++] = data[i];
  }
  return out.subarray(0, n);
}

function quoteBytes(data) {
  return '"' + Array.from(data, byte => '\\' + byte.toString(8).padStart(3, '0')).join('') + '"';
}

class TerminalStream {
  constructor(ws, name, manager) {
    this.ws = ws;
    this.name = name;
    this.manager = manager;
    this.pending = [];
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.snapshotting = true;
    this.ready = false;
    this.inputQueue = Promise.resolve();
    this.inputBytes = 0;
    this.pasteBuffer = `hub-web-${randomUUID()}`;
    this.size = { cols: 80, rows: 24 };
    this.initialized = false;
    this.startTimer = setTimeout(() => this.close(1008, 'Terminal initialization timed out'), 10000);
    ws.on('message', (data, binary) => this.message(data, binary));
    ws.on('close', () => this.close());
    ws.on('error', () => this.close());
  }

  send(data) {
    if (this.closed || this.ws.readyState !== 1) return;
    if (this.ws.bufferedAmount > LIMIT) return this.close(1013, 'Terminal client is too slow');
    this.ws.send(Buffer.isBuffer(data) ? data : JSON.stringify(data));
  }

  async start() {
    await this.manager.ensurePane(this.name);
    if (this.closed) return;
    // A control client observes the inner PTY. It does not put the browser in
    // tmux's alternate screen and never enters the shared pane's copy mode.
    const env = { ...process.env, TERM: 'xterm-256color', PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ''}` };
    delete env.TMUX;
    this.proc = spawn('tmux', ['-C', 'attach-session', '-t', `=${this.name}`], {
      stdio: ['pipe', 'pipe', 'ignore'], env,
    });
    this.proc.on('error', () => this.close(1011, 'Unable to attach terminal'));
    this.proc.on('exit', () => this.close(1011, 'Terminal detached'));
    this.proc.stdin.on('error', () => this.close(1011, 'Terminal input closed'));
    this.proc.stdout.on('data', chunk => this.read(chunk));
    await this.command([`refresh-client -C ${this.size.cols},${this.size.rows}`]);
    await this.snapshot();
  }

  command(commands) {
    if (this.closed) return Promise.reject(new Error('Terminal closed'));
    return new Promise((resolve, reject) => {
      const job = { remaining: commands.length, results: [], resolve, reject };
      job.timer = setTimeout(() => this.close(1011, 'Terminal command timed out'), 10000);
      this.pending.push(job);
      this.proc.stdin.write(commands.join(' ; ') + '\n');
    });
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > LIMIT) return this.close(1013, 'Terminal output is too large');
    let end;
    while (!this.closed && (end = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      this.line(line);
    }
  }

  line(line) {
    const text = line.toString('utf8');
    if (this.block) {
      if (text === `%end ${this.block.id}` || text === `%error ${this.block.id}`) {
        const block = this.block;
        this.block = null;
        // The attach-session reply (flags=0) is not one of our commands.
        if (!block.command) return;
        const job = this.pending[0];
        if (!job) return this.close(1011, 'Unexpected terminal reply');
        if (text.startsWith('%error ')) job.error = true;
        job.results.push(Buffer.concat(block.lines));
        if (--job.remaining === 0) {
          this.pending.shift(); clearTimeout(job.timer);
          if (job.error) job.reject(new Error('tmux command failed'));
          else job.resolve(job.results);
        }
      } else {
        this.block.bytes += line.length + 1;
        if (this.block.bytes > LIMIT) return this.close(1013, 'Terminal history is too large');
        this.block.lines.push(line, Buffer.from('\n'));
      }
      return;
    }
    const begin = /^%begin (\d+ \d+ (\d+))$/.exec(text);
    if (begin) {
      this.block = { id: begin[1], command: Boolean(Number(begin[2]) & 1), lines: [], bytes: 0 };
    } else if (text.startsWith('%output ')) {
      const space = line.indexOf(32, 8);
      if (!this.snapshotting && line.toString('ascii', 8, space) === this.pane) {
        this.send(unescape(line.subarray(space + 1)));
      }
    } else if (/^%(layout-change|window-pane-changed|session-window-changed) /.test(text)) {
      if (this.ready) this.scheduleSnapshot();
    } else if (text.startsWith('%exit')) this.close(1000, 'Terminal exited');
  }

  scheduleSnapshot() {
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => this.snapshot().catch(() => this.close(1011, 'Unable to restore terminal')), 40);
  }

  async snapshot() {
    if (this.closed) return;
    // The commands run together in tmux's event loop. Output before the last
    // reply is covered by this snapshot; subsequent output belongs to the live
    // stream. Deliver/reset at the final reply, not a later event-loop tick.
    this.snapshotting = true;
    const target = `=${this.name}:`;
    const capture = `capture-pane -p -e -C -J -t ${target}`;
    const job = this.command([
      `display-message -p -t ${target} '${fields.map(f => `#{${f}}`).join('|')}'`,
      `${capture} -S -20000`, `${capture} -a -q`,
      `${capture} -S -20000 -E -1`, `${capture} -S 0`,
      `capture-pane -p -C -P -t ${target}`,
    ]);
    // The parser must execute the barrier synchronously: stdout can contain the
    // last reply AND new output in one chunk (Promises alone would drop it).
    const pending = this.pending.at(-1);
    const resolve = pending.resolve;
    pending.resolve = replies => {
      const values = replies[0].toString().trimEnd().split('|');
      const meta = Object.fromEntries(fields.map((f, i) => [f, f === 'pane_id' || f === 'pane_tabs' ? values[i] : Number(values[i])]));
      if (!/^%\d+$/.test(meta.pane_id) || !meta.pane_width || !meta.pane_height) {
        pending.reject(new Error('Invalid terminal snapshot')); return;
      }
      this.pane = meta.pane_id;
      const decode = b => unescape(b.subarray(0, Math.max(0, b.length - 1))).toString('utf8');
      this.send({ type: 'snapshot', meta, screen: decode(replies[1]),
        normal: meta.alternate_on ? decode(replies[2]) : '',
        history: meta.alternate_on && meta.history_size ? decode(replies[3]) : '',
        alternate: meta.alternate_on ? decode(replies[4]) : '',
        pending: unescape(replies[5].subarray(0, Math.max(0, replies[5].length - 1))).toString('base64') });
      this.snapshotting = false;
      this.ready = true;
      clearTimeout(this.startTimer);
      resolve(replies);
    };
    await job;
  }

  message(data, binary) {
    if (binary || data.length > 1024 * 1024) return this.close(1009, 'Invalid terminal input');
    let msg;
    try { msg = JSON.parse(data); } catch { return this.close(1008, 'Invalid terminal message'); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.close(1008, 'Invalid terminal message');
    if (msg.type === 'resize') {
      if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows) || msg.cols < 2 || msg.cols > 500 || msg.rows < 2 || msg.rows > 300) return this.close(1008, 'Invalid terminal size');
      this.size = { cols: msg.cols, rows: msg.rows };
      if (!this.initialized) {
        this.initialized = true;
        this.start().catch(() => this.close(1011, 'Unable to open terminal'));
      } else if (this.proc) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
          this.command([`refresh-client -C ${this.size.cols},${this.size.rows}`])
            .then(() => this.scheduleSnapshot()).catch(() => this.close(1011, 'Unable to resize terminal'));
        }, 60);
      }
      return;
    }
    if (!this.ready || !['input', 'paste', 'binary'].includes(msg.type) || typeof msg.data !== 'string') return this.close(1008, 'Terminal is not ready');
    const bytes = Buffer.from(msg.data, msg.type === 'binary' ? 'latin1' : 'utf8');
    if (!bytes.length) return;
    this.inputBytes += bytes.length;
    if (this.inputBytes > 1024 * 1024) return this.close(1009, 'Too much pending input');
    this.inputQueue = this.inputQueue.then(async () => {
      const commands = [];
      if (msg.type === 'paste') {
        for (let i = 0; i < bytes.length; i += 2048) {
          commands.push(`set-buffer ${i ? '-a ' : ''}-b ${this.pasteBuffer} -- ${quoteBytes(bytes.subarray(i, i + 2048))}`);
        }
        // tmux knows the application's bracketed-paste mode even on reconnect.
        commands.push(`paste-buffer -p -d -b ${this.pasteBuffer} -t ${this.pane}`);
      } else {
        for (let i = 0; i < bytes.length; i += 2048) {
          commands.push(`send-keys -t ${this.pane} -H ${Array.from(bytes.subarray(i, i + 2048), byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
        }
      }
      await this.command(commands);
    }).catch(() => this.close(1011, 'Unable to send terminal input'))
      .finally(() => { this.inputBytes -= bytes.length; });
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startTimer); clearTimeout(this.snapshotTimer); clearTimeout(this.resizeTimer);
    for (const job of this.pending) { clearTimeout(job.timer); job.reject(new Error('Terminal closed')); }
    this.pending = [];
    if (this.proc) {
      // Detach this observer only. Never kill the session or the pane's process.
      this.proc.stdin.end(`delete-buffer -b ${this.pasteBuffer}\n`);
      const timer = setTimeout(() => this.proc.kill('SIGTERM'), 1000);
      timer.unref(); this.proc.once('exit', () => clearTimeout(timer));
    }
    if (this.ws.readyState < 2) this.ws.close(code, reason);
  }
}

function setupTerminalStreams(server, manager) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const streams = new Set();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.alive === false) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 30000);
  heartbeat.unref();
  server.on('upgrade', (req, socket, head) => {
    if (socket.destroyed) return;
    const match = /^\/ws\/terminal\/([a-zA-Z0-9_-]+)$/.exec((req.url || '').split('?')[0]);
    if (!match) return;
    let valid = false;
    try {
      valid = manager.getSession(match[1]).status === 'running';
      // Caddy preserves Host; accepting no Origin also supports CLI clients.
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) valid = false;
    } catch {}
    if (!valid) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      const stream = new TerminalStream(ws, match[1], manager);
      streams.add(stream);
      ws.on('close', () => streams.delete(stream));
    });
  });
  for (const event of ['session:stopped', 'session:deleted', 'session:exited']) {
    manager.on(event, session => {
      for (const stream of streams) if (stream.name === session.name) stream.close(1000, 'Session stopped');
    });
  }
  return { close() { clearInterval(heartbeat); for (const stream of streams) stream.close(1001, 'Server restarting'); wss.close(); } };
}

module.exports = { setupTerminalStreams, unescape, quoteBytes };
