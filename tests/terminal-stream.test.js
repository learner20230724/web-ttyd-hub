const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { fixture, until, pause } = require('./terminal-fixture.cjs');
const { unescape } = require('../server/services/terminal-stream');

test('control output preserves escaped bytes, literal escapes and split UTF-8', () => {
  assert.deepEqual(unescape(Buffer.from('a\\033[31m\\134033\\\\中\\000')), Buffer.from('a\x1b[31m\\033\\中\x00'));
  assert.deepEqual(unescape(Buffer.from('\\344\\270\\255')), Buffer.from('中'));
});

test('terminal stream restores history, streams raw output, pastes safely and detaches without killing tasks', { timeout: 30000, skip: process.platform === 'win32' ? 'Requires Linux tmux/ttyd' : false }, async () => {
  const f = await fixture();
  const sockets = [];
  async function open(origin) {
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + `/ws/terminal/${f.session.name}`, origin ? { origin } : {});
    sockets.push(ws);
    const messages = [], output = [];
    ws.on('message', (data, binary) => { if (binary) output.push(data); else messages.push(JSON.parse(data)); });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await until(() => messages.some(m => m.type === 'snapshot'));
    return { ws, messages, output, send: msg => ws.send(JSON.stringify(msg)) };
  }
  try {
    f.output('\x1b[2J\x1b[H' + Array.from({ length: 600 }, (_, i) => `ROW_${String(i).padStart(4, '0')} 中文 \\033 \x1b[31mRED\x1b[0m\r\n`).join('') + '\x1b[?2004h');
    await until(() => Number(f.tm('display-message', '-p', '-t', f.target, '#{history_size}')) > 550);
    const a = await open();
    assert.ok(a.messages[0].screen.includes('ROW_0000'));
    assert.ok(a.messages[0].screen.includes('ROW_0599'));
    assert.ok(a.messages[0].screen.includes('中文 \\033'));
    assert.ok(a.messages[0].screen.includes('\x1b[31m'));
    assert.equal(a.messages[0].pending, '');
    const b = await open();
    f.output('\x1b[32mSTREAM_END中文\x1b[0m\r\n');
    await until(() => Buffer.concat(a.output).includes('STREAM_END中文') && Buffer.concat(b.output).includes('STREAM_END中文'));
    assert.equal(f.tm('display-message', '-p', '-t', f.target, '#{pane_in_mode}'), '0');
    const typed = 'x中文\x1b[D';
    const paste = '粘贴\n"; kill-server ; # \\ $()\n末尾';
    a.send({ type: 'input', data: typed });
    a.send({ type: 'paste', data: paste });
    const expected = typed + '\x1b[200~' + paste.replaceAll('\n', '\r') + '\x1b[201~';
    await until(() => f.input().length >= Buffer.byteLength(expected));
    assert.equal(f.input().toString(), expected);
    const largePaste = '大量粘贴 line\\end\n'.repeat(2000);
    a.send({ type: 'paste', data: largePaste });
    const allInput = expected + '\x1b[200~' + largePaste.replaceAll('\n', '\r') + '\x1b[201~';
    await until(() => f.input().length >= Buffer.byteLength(allInput));
    assert.equal(f.input().toString(), allInput);
    // A slow reader is not allowed to enter tmux copy mode or pause a producer.
    b.send({ type: 'resize', cols: 80, rows: 24 });
    await until(() => a.messages.some(m => m.meta.pane_width === 80));
    const reconnected = await open();
    assert.ok(reconnected.messages[0].screen.includes('STREAM_END中文'));
    reconnected.ws.send('null');
    const [closeCode] = await once(reconnected.ws, 'close');
    assert.equal(closeCode, 1008);
    assert.ok(await f.api(), 'Malformed client input must not stop the server');
    assert.equal(f.tm('display-message', '-p', '-t', f.target, '#{pane_pid}'), f.pid);
    const forbidden = new WebSocket(f.base.replace('http:', 'ws:') + `/ws/terminal/${f.session.name}`, { origin: 'https://untrusted.invalid' });
    forbidden.on('error', () => {});
    await once(forbidden, 'unexpected-response').then(([, response]) => { assert.equal(response.statusCode, 403); response.resume(); forbidden.terminate(); });
    for (const socket of sockets) socket.close();
    await until(() => f.tm('list-clients', '-F', '#{client_control_mode}') === '');
    assert.equal(f.tm('display-message', '-p', '-t', f.target, '#{pane_pid}'), f.pid);
    assert.equal(f.tm('list-buffers', '-F', '#{buffer_name}'), '');
    await pause(50);
  } finally { for (const socket of sockets) socket.terminate(); await f.cleanup(); }
});
