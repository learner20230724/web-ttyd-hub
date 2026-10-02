const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

let configText = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', x => { configText += x; });
process.stdin.on('end', () => start(JSON.parse(configText)));

function start(config) {
  const app = express(), server = http.createServer(app);
  const term = new Terminal({ cols: 120, rows: 40, scrollback: 20000, allowProposedApi: true });
  const serializer = new SerializeAddon(); term.loadAddon(serializer);
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // Never pass web/tunnel credentials to the user's shell.
  for (const key of Object.keys(env)) if (/^HUB_(AUTH|WORKER)/.test(key)) delete env[key];
  const args = ['-NoLogo', '-NoExit'];
  const setup = "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $env:PYTHONIOENCODING='utf-8'; " +
    (config.kind === 'codex' ? "& '" + (config.codexExe || 'codex').replace(/'/g, "''") + "' --yolo" : "");
  args.push('-EncodedCommand', Buffer.from(setup, 'utf16le').toString('base64'));
  const shell = pty.spawn(config.shell, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: config.cwd, env, useConpty: true });
  // Answer terminal queries even when only the phone's HTTP reader is attached.
  term.onData(data => { if (alive) shell.write(data); });
  let alive = true, queue = Promise.resolve(), updatedAt = new Date().toISOString();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const authorized = req => req.headers['x-hub-worker-token'] === config.token;
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.get('/health', (_req, res) => res.json({ name: config.name, pid: shell.pid, alive }));
  const flush = () => new Promise(resolve => term.write('', resolve));
  app.get('/history', async (_req, res) => {
    await flush();
    const buffer = term.buffer.active, lines = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
    // Serialize visible lines without cursor navigation for the mobile ANSI reader.
    let ansi = '', lastStyle = '';
    const color = (cell, fg) => {
      const n = fg ? cell.getFgColor() : cell.getBgColor();
      if (fg ? cell.isFgRGB() : cell.isBgRGB()) return `${fg ? 38 : 48};2;${n >> 16 & 255};${n >> 8 & 255};${n & 255}`;
      if (fg ? cell.isFgPalette() : cell.isBgPalette()) return `${fg ? 38 : 48};5;${n}`;
      return fg ? '39' : '49';
    };
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i); if (!line) continue;
      const length = line.translateToString(true).length;
      let content = '';
      for (let j = 0; j < line.length; j++) {
        const cell = line.getCell(j); if (!cell || cell.getWidth() === 0) continue;
        const text = cell.getChars() || ' ';
        const style = [0, color(cell, true), color(cell, false), ...(cell.isBold() ? [1] : []), ...(cell.isDim() ? [2] : []), ...(cell.isItalic() ? [3] : []), ...(cell.isUnderline() ? [4] : []), ...(cell.isInverse() ? [7] : [])].join(';');
        if (style !== lastStyle) { content += `\x1b[${style}m`; lastStyle = style; }
        content += text;
        if (j >= length && !line.translateToString(true, j + 1)) break;
      }
      ansi += content.replace(/ +$/, '') + '\n';
    }
    res.json({ name: config.name, text: lines.join('\n').trimEnd(), ansi: ansi.trimEnd() + '\x1b[0m', capturedAt: updatedAt, activity: { available: false, busy: false, completed: null } });
  });
  const keys = { Enter: '\r', Escape: '\x1b', Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D', 'S-Left': '\x1b[1;2D', Tab: '\t', 'C-c': '\x03' };
  app.post('/input', (req, res) => {
    const { text, key } = req.body;
    if (!alive) return res.status(400).json({ error: 'Shell exited' });
    if (key != null && !Object.hasOwn(keys, key)) return res.status(400).json({ error: 'Unsupported key' });
    if (text != null && (typeof text !== 'string' || Buffer.byteLength(text) > 64000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text))) return res.status(400).json({ error: 'Invalid input' });
    queue = queue.catch(() => {}).then(async () => {
      if (text) {
        shell.write(term.modes.bracketedPasteMode ? '\x1b[200~' + text + '\x1b[201~' : text);
        if (key) await new Promise(resolve => setTimeout(resolve, 80));
      }
      if (key) shell.write(keys[key]);
    });
    queue.then(() => res.json({ ok: true }), () => res.status(400).json({ error: 'Unable to write to terminal' }));
  });
  app.post('/terminate', (_req, res) => { res.json({ ok: true }); setTimeout(() => { shell.kill(); process.exit(0); }, 100); });
  app.post('/detach', (_req, res) => { for (const ws of wss.clients) ws.close(1000, 'Session stopped'); res.json({ ok: true }); });
  const root = `/terminal/${config.name}`;
  app.get(root + '/vendor/xterm.js', (_req, res) => res.sendFile(require.resolve('@xterm/xterm')));
  app.get(root + '/vendor/fit.js', (_req, res) => res.sendFile(require.resolve('@xterm/addon-fit')));
  app.get(root + '/vendor/xterm.css', (_req, res) => res.sendFile(path.join(path.dirname(require.resolve('@xterm/xterm')), '../css/xterm.css')));
  app.get([root, root + '/'], (_req, res) => {
    const base = (config.base || '') + root;
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${base}/vendor/xterm.css"><style>html,body,#terminal{margin:0;width:100%;height:100%;background:#000;overflow:hidden}#status{position:absolute;right:8px;top:4px;color:#fbbf24;font:12px sans-serif;z-index:2}</style></head><body><div id="terminal"></div><div id="status"></div><script src="${base}/vendor/xterm.js"></script><script src="${base}/vendor/fit.js"></script><script>
const term=window.term=new Terminal({scrollback:10000,fontSize:14,theme:{background:'#000000'}});
const fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(document.getElementById('terminal'));
let ws,retry,disposed=false;const status=document.getElementById('status');
function resize(){fit.fit();if(ws?.readyState===1)ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));}
function connect(){ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+${JSON.stringify(base + '/ws')});
ws.onopen=()=>{status.textContent='';term.reset();resize();term.focus()};
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='output')term.write(m.data);if(m.type==='exit')status.textContent='进程已退出';};
ws.onclose=()=>{status.textContent='连接中断，正在重连…';if(!disposed)retry=setTimeout(connect,1500)};}
term.onData(data=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'input',data}))});
new ResizeObserver(resize).observe(document.body);window.addEventListener('beforeunload',()=>{disposed=true;clearTimeout(retry);ws?.close()});connect();
</script></body></html>`);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req) || req.url.split('?')[0] !== root + '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      ws.send(JSON.stringify({ type: 'output', data: serializer.serialize({ scrollback: 10000 }) }));
      ws.on('message', raw => {
        try {
          const data = JSON.parse(raw);
          if (data.type === 'input' && alive && typeof data.data === 'string' && data.data.length <= 64000 && !/^\x1b\[[?0-9;]*[nRc]$/.test(data.data)) shell.write(data.data);
          if (data.type === 'resize' && Number.isInteger(data.cols) && Number.isInteger(data.rows) && data.cols >= 2 && data.cols <= 500 && data.rows >= 2 && data.rows <= 200) {
            shell.resize(data.cols, data.rows); term.resize(data.cols, data.rows);
          }
        } catch { ws.close(1008, 'Invalid input'); }
      });
      ws.on('error', () => {});
    });
  });
  shell.onData(data => {
    term.write(data); updatedAt = new Date().toISOString();
    for (const ws of wss.clients) if (ws.readyState === 1) {
      if (ws.bufferedAmount > 2 * 1024 * 1024) ws.terminate();
      else ws.send(JSON.stringify({ type: 'output', data }));
    }
  });
  shell.onExit(() => {
    alive = false;
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit' }));
    // An exited shell cannot be reattached; do not leak an idle worker per exit.
    setTimeout(() => {
      try { if (JSON.parse(fs.readFileSync(config.stateFile, 'utf8')).pid === process.pid) fs.unlinkSync(config.stateFile); } catch {}
      process.exit(0);
    }, 1500);
  });
  server.listen(0, '127.0.0.1', () => {
    const temp = config.stateFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ port: server.address().port, pid: process.pid }), { mode: 0o600 });
    fs.renameSync(temp, config.stateFile);
  });
  const heartbeat = setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, 25000); heartbeat.unref();
}
