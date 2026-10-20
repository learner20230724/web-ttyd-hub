const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

// Capture terminal writes in this test process. Never address a real tmux pane.
let terminal;
const originalSpawn = childProcess.spawn, originalExecFile = childProcess.execFile;
childProcess.spawn = (_program, args) => {
  terminal.commands.push(args[0]);
  const child = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = () => {
    terminal.loaded?.(child);
    if (!terminal.holdLoad) queueMicrotask(() => child.emit('close', 0));
  };
  return child;
};
childProcess.execFile = (_program, args, options, callback) => {
  terminal.commands.push(args[0]);
  if (args[0] === 'paste-buffer') terminal.afterPaste?.();
  queueMicrotask(() => (typeof options === 'function' ? options : callback)(null, '', ''));
};
const Linux = require('../server/services/session-manager');
const Windows = require('../server/services/windows-session-manager');
childProcess.spawn = originalSpawn; childProcess.execFile = originalExecFile;

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(Manager) {
  terminal = { commands: [], holdLoad: false };
  const manager = Object.create(Manager.prototype);
  manager.inputQueues = new Map();
  manager.sessions = new Map([['fixture', { name: 'fixture', status: 'running', createdAt: 'old' }]]);
  manager.ensurePane = async () => {};
  manager.call = async (_session, _route, data) => { terminal.commands.push(data.key ? 'worker-key' : 'worker-text'); return { ok: true }; };
  return manager;
}
function replace(manager) { manager.sessions.set('fixture', { name: 'fixture', status: 'running', createdAt: 'replacement' }); }

for (const [platform, Manager] of [['Linux', Linux], ['Windows', Windows]]) {
  test(`${platform} queued input cannot reach a replacement session with the same name`, async () => {
    const manager = fixture(Manager), previous = deferred(); let ensured = 0;
    manager.inputQueues.set('fixture', previous.promise);
    manager.ensurePane = async () => { ensured++; };
    const pending = manager.input('fixture', { key: 'Enter' });
    replace(manager); previous.resolve();
    await assert.rejects(pending, /会话已更换/);
    assert.equal(ensured, 0); assert.deepEqual(terminal.commands, []);
    await manager.input('fixture', { key: 'Enter' });
    assert.deepEqual(terminal.commands, [platform === 'Linux' ? 'send-keys' : 'worker-key'], 'New input for the replacement still works');
  });
}

test('Linux input rechecks identity after asynchronous pane activation', async () => {
  const manager = fixture(Linux), started = deferred(), activation = deferred();
  manager.ensurePane = async () => { started.resolve(); await activation.promise; };
  const pending = manager.input('fixture', { text: 'Old session only' });
  await started.promise; replace(manager); activation.resolve();
  await assert.rejects(pending, /会话已更换/); assert.deepEqual(terminal.commands, []);
});

test('Linux discards a loaded paste when the target session changed before delivery', async () => {
  const manager = fixture(Linux), loaded = deferred();
  terminal.holdLoad = true; terminal.loaded = loaded.resolve;
  const pending = manager.input('fixture', { text: 'Old session only' });
  const child = await loaded.promise; replace(manager); child.emit('close', 0);
  await assert.rejects(pending, /会话已更换/);
  assert.deepEqual(terminal.commands, ['load-buffer', 'delete-buffer'], 'Cleanup runs without pasting into the replacement');
});

test('Linux does not send delayed Enter after a pasted session is replaced', async () => {
  const manager = fixture(Linux); terminal.afterPaste = () => replace(manager);
  await assert.rejects(manager.input('fixture', { text: 'Old session only', key: 'Enter' }), /会话已更换/);
  assert.deepEqual(terminal.commands, ['load-buffer', 'paste-buffer', 'delete-buffer']);
});

test('Windows does not send delayed Enter after a pasted worker is replaced', async () => {
  const manager = fixture(Windows);
  manager.call = async (_session, _route, data) => { terminal.commands.push(data.key ? 'worker-key' : 'worker-text'); replace(manager); return { ok: true }; };
  await assert.rejects(manager.input('fixture', { text: 'Old session only', key: 'Enter' }), /会话已更换/);
  assert.deepEqual(terminal.commands, ['worker-text']);
});
