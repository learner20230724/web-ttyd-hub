const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');

test('upload, remove from a prompt, and resolve only complete files in the current Codex conversation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-files-'));
  const previous = process.env.HUB_FILE_DIR;
  process.env.HUB_FILE_DIR = root;
  const session = { name: 'one', createdAt: 'first', shell: 'codex', status: 'running', codexThreadId: 'A' };
  const inputs = [];
  const manager = { getSession: () => session, input: (_, body) => { inputs.push(body); return { ok: true }; } };
  const files = require('../server/services/session-files');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../server/routes/sessions')(manager));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    if (previous === undefined) delete process.env.HUB_FILE_DIR; else process.env.HUB_FILE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });

  const url = 'http://127.0.0.1:' + server.address().port + '/api/one';
  const identity = { 'X-TTYD-Generation': 'first', 'X-TTYD-Thread': 'A' };
  const upload = (name, body, headers = identity) => fetch(url + '/files?' + new URLSearchParams({ name }), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body
  });
  const send = (ids, headers = identity) => fetch(url + '/input', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ text: '读 B2', key: 'Enter', files: ids }) });
  const name = '费用 明细.csv';
  const values = ['A,B\n1,98', 'A,B\n2,21'];
  const uploads = await Promise.all(values.map(v => upload(name, v)));
  assert(uploads.every(response => response.status === 201));
  const [first, second] = await Promise.all(uploads.map(response => response.json()));
  assert.notEqual(first.id, second.id);
  assert.equal(first.name, name);
  assert.equal(inputs.length, 0);
  assert.equal((await send([second.id])).status, 200);
  const [, filename, , instruction] = inputs[0].text.split('\n');
  assert.equal(instruction, '读 B2');
  assert.equal(await fs.readFile(filename, 'utf8'), values[1]);
  assert.equal(files.displayPrompt(inputs[0].text), '读 B2\n附件：' + name);
  assert.equal((await send([first.id, second.id])).status, 200);
  assert.equal(await fs.readFile(inputs[1].text.split('\n')[1], 'utf8'), values[0]);

  const additional = [];
  for (let i = 2; i < 20; i++) additional.push((await (await upload('note-' + i + '.txt', 'ok')).json()).id);
  const twenty = [first.id, second.id, ...additional];
  assert.equal((await send(twenty)).status, 200);
  assert.equal((await send([...twenty, first.id])).status, 400);
  assert.equal((await upload('../outside', 'x')).status, 400);
  assert.equal((await upload('空.txt', '')).status, 201);
  assert.equal((await send(['../../outside'])).status, 400);
  assert.equal((await send([second.id], {})).status, 409);
  session.codexThreadId = 'B';
  assert.equal((await send([second.id])).status, 409);
  assert.equal((await send([second.id], { ...identity, 'X-TTYD-Thread': 'B' })).status, 400);
  session.createdAt = 'second';
  assert.equal((await upload(name, 'x')).status, 409);
  session.shell = 'bash';
  assert.equal((await upload(name, 'x', { 'X-TTYD-Generation': 'second', 'X-TTYD-Thread': 'B' })).status, 400);
  assert.equal(inputs.length, 3);
  const limit = 100 * 1024 * 1024;
  assert.throws(() => files.checkSize(limit + 1), /100 MB/);
  files.checkSize(limit);
  session.shell = 'codex';
  async function* interrupted() { yield Buffer.from('partial'); throw new Error('closed'); }
  await assert.rejects(files.save(session, name, interrupted(), () => {}), /closed/);
  // Also enforce the streaming limit when the client omits Content-Length.
  const chunk = Buffer.alloc(1024 * 1024);
  async function* tooLarge() { for (let i = 0; i < 100; i++) yield chunk; yield Buffer.from([1]); }
  const response = await fetch(url + '/files?name=large.bin', { method: 'POST', duplex: 'half',
    headers: { 'Content-Type': 'application/octet-stream', 'X-TTYD-Generation': 'second', 'X-TTYD-Thread': 'B' }, body: tooLarge() });
  assert.equal(response.status, 413);
  const contents = await fs.readdir(root, { recursive: true });
  assert(contents.every(entry => !entry.includes('.upload-')));
});
