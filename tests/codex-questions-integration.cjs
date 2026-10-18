// Installed Codex + isolated local Responses fixture; no real model calls or user threads.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { CodexRpc } = require('../server/services/codex-rpc');
const { CodexQuestions } = require('../server/services/codex-questions');
const { consumeRollout } = require('../server/services/codex-activity');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error('Fixture timed out'); }
let home, child, client, bridge, binding, seq = 0;
const received = [], events = [];
const fake = http.createServer(async (req, res) => {
  try {
    let input = ''; for await (const chunk of req) input += chunk;
    if (req.url !== '/v1/responses') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    const body = JSON.parse(input); received.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    emit({ type: 'response.created', response: { id: 'response' + seq, status: 'in_progress', output: [] } });
    const item = seq++ % 2 === 0
      ? { type: 'function_call', id: 'fc' + seq, call_id: 'question' + seq, name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'choice', header: '方案', question: '选择哪个方案？', options: [{ label: '方案甲', description: '简洁' }, { label: '方案乙', description: '详细' }] }] }) }
      : { type: 'message', role: 'assistant', id: 'message' + seq, content: [{ type: 'output_text', text: 'Fixture completed.', annotations: [] }] };
    emit({ type: 'response.output_item.added', output_index: 0, item });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { id: 'response' + seq, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  } catch (err) { res.destroy(err); }
});
(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-questions-test-'));
  fake.listen(0, '127.0.0.1'); await once(fake, 'listening');
  const socket = path.join(home, 'app.sock');
  await fs.writeFile(path.join(home, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${fake.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  child = spawn('codex', ['app-server', '--listen', `unix://${socket}`], { env: { ...process.env, CODEX_HOME: home }, stdio: 'ignore' });
  await until(() => fs.stat(socket).then(x => x.isSocket()).catch(() => false));
  client = new CodexRpc(); client.on('message', m => events.push(m)); await client.connect(socket);
  bridge = new CodexQuestions({ binding: () => binding, verifyBinding: async () => binding });
  for (const action of ['answer', 'skip']) {
    const { thread } = await client.call('thread/start', { cwd: home, model: 'fixture-model', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'read-only', experimentalRawEvents: false, environments: [] });
    binding = { socket, threadId: thread.id };
    await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Ask the fixture question.', text_elements: [] }], collaborationMode: { mode: 'plan', settings: { model: 'fixture-model', reasoning_effort: null, developer_instructions: null } } });
    await until(() => events.find(e => e.method === 'item/tool/requestUserInput' && e.params.threadId === thread.id));
    const view = await until(async () => { const data = await bridge.read('fixture'); return data.requests.length ? data : null; });
    assert.equal(view.requests.length, 1, 'Pending question is replayed to a newly attached mobile client');
    const before = events.filter(e => e.method === 'turn/started').length;
    assert.deepEqual(await bridge.respond('fixture', view.requests[0].id, { action, answers: { choice: '方案甲\n中文补充' } }), { ok: true });
    await until(() => events.find(e => e.method === 'turn/completed' && e.params.threadId === thread.id));
    // Observe completion without sending another message or touching the Hub UI.
    const requestCount = received.length;
    const state = { path: thread.path, offset: 0, busy: false, completed: null };
    await until(async () => { await consumeRollout(state, (await fs.stat(thread.path)).size); return state.completed; });
    assert.equal(state.phase, 'completed'); assert.equal(state.busy, false);
    assert.equal(received.length, requestCount, 'Completion does not require an extra model request');
    assert(events.some(e => e.method === 'serverRequest/resolved' && e.params.threadId === thread.id));
    assert.equal((await bridge.read('fixture')).requests.length, 0);
    assert.equal(events.filter(e => e.method === 'turn/started').length, before, 'Reply/skip continues the same turn');
    const result = received.at(-1).input.filter(x => x.type === 'function_call_output').at(-1);
    const values = JSON.parse(result.output).answers.choice.answers;
    assert.deepEqual(values, action === 'skip' ? [] : ['方案甲\n中文补充']);
  }
  console.log('Installed Codex: pending question replay, Chinese answers, safe skip, cross-client resolution and continued turns passed.');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  bridge?.close(); client?.close(); child?.kill();
  fake.closeAllConnections(); fake.close();
  await delay(400); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (home) await fs.rm(home, { recursive: true, force: true });
});
