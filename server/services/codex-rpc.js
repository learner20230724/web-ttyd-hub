// Narrow local app-server transport. Never read, copy, or return Codex credentials.
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const WebSocket = require('ws');

class CodexRpc extends EventEmitter {
  constructor() { super(); this.pending = new Map(); this.sequence = 0; this.closed = false; }
  async connect(socket) {
    if (socket) {
      // Unix app-server sockets speak WebSocket, not JSONL.
      this.ws = new WebSocket(`ws+unix:${socket}:/`, { handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024 });
      this.ws.on('message', data => this.receive(data));
      this.ws.on('error', () => this.close());
      this.ws.on('close', () => this.close());
      await new Promise((resolve, reject) => {
        this.ws.once('open', resolve);
        this.ws.once('error', () => reject(new Error('Codex 连接失败')));
      });
    } else {
      // Match the Hub terminal launcher: systemd may not inherit the proxy/PATH
      // configured by the user's interactive shell. Arguments stay separate.
      const shell = process.platform !== 'win32' && require('node:fs').existsSync('/bin/bash');
      this.child = shell
        ? spawn('/bin/bash', ['-ic', 'exec "$@"', 'hub-codex-account', 'codex', 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] })
        : spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.child.on('error', () => this.close()); this.child.on('exit', () => this.close());
      this.child.stdin.on('error', () => this.close());
      this.lines = createInterface({ input: this.child.stdout });
      this.lines.on('line', line => this.receive(line));
    }
    await this.call('initialize', { clientInfo: { name: 'ttyd_hub', title: 'TTYD Hub', version: '1.0.0' }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } });
    this.send({ method: 'initialized', params: {} });
    return this;
  }
  receive(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.method) { this.emit('message', message); return; }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id); clearTimeout(request.timer);
    // Upstream errors can contain local details; keep them out of browser responses.
    if (message.error) request.reject(new Error('Codex 暂时无法提供此数据'));
    else request.resolve(message.result);
  }
  send(message) {
    if (this.closed) throw new Error('Codex 连接已断开');
    const data = JSON.stringify(message);
    if (this.ws) this.ws.send(data);
    else this.child.stdin.write(data + '\n');
  }
  call(method, params, timeout = 20000) {
    if (this.closed) return Promise.reject(new Error('Codex 连接已断开'));
    return new Promise((resolve, reject) => {
      const id = `hub:${++this.sequence}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 响应超时，请稍后重试')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Codex 连接已断开')); }
    this.pending.clear(); this.lines?.close(); this.ws?.terminate();
    if (this.child) {
      const child = this.child; child.stdin.end(); child.kill();
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000); timer.unref();
    }
    this.emit('close');
  }
}
module.exports = { CodexRpc };
