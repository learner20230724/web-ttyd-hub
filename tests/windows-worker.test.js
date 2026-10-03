const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Capture the real worker's PTY arguments without starting a shell or server.
function startupCommand(config) {
  const stdin = new EventEmitter();
  stdin.setEncoding = () => {};
  const captured = new Error('PTY captured');
  let args;
  const mocks = {
    express: () => ({}),
    'node:http': { createServer: () => ({}) },
    'node-pty': { spawn: (_shell, value) => { args = value; throw captured; } },
    ws: {},
    '@xterm/headless': { Terminal: class { loadAddon() {} } },
    '@xterm/addon-serialize': { SerializeAddon: class {} },
  };
  const filename = path.join(__dirname, '../server/services/windows-worker.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
    process: { stdin, env: {} }, Buffer,
  }, { filename });
  stdin.emit('data', JSON.stringify(config));
  assert.throws(() => stdin.emit('end'), error => error === captured);
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
}

test('Windows Codex sessions launch with --yolo', () => {
  assert.ok(startupCommand({ kind: 'codex' }).endsWith("& 'codex' --yolo"));
});

test('Windows Codex executable paths stay quoted with --yolo', () => {
  const command = startupCommand({ kind: 'codex', codexExe: "C:\\中文 user's folder\\codex.exe" });
  assert.ok(command.endsWith("& 'C:\\中文 user''s folder\\codex.exe' --yolo"));
});

test('Windows PowerShell sessions do not launch Codex or add --yolo', () => {
  const command = startupCommand({ kind: 'powershell' });
  assert.doesNotMatch(command, /codex|--yolo/);
});

test('Windows Codex resumes the selected UUID with --yolo', () => {
  const id = '01900000-0000-7000-8000-000000000001';
  assert.ok(startupCommand({ kind: 'codex', resumeThreadId: id }).endsWith(`& 'codex' resume ${id} --yolo`));
});

test('Windows launcher rejects command injection in resume IDs before spawning', () => {
  assert.throws(() => startupCommand({ kind: 'codex', resumeThreadId: "'; Write-Output BAD; '" }));
});
