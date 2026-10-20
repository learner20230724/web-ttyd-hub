// Installed Codex, a private tmux server and a local synthetic model only.
// A resumed completed thread must be readable before the user sends any input.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { CodexRpc } = require('../server/services/codex-rpc');
const { LinuxCodexObserver } = require('../server/services/codex-observer');
const { CodexActivity } = require('../server/services/codex-activity');
const SessionManager = require('../server/services/session-manager');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await delay(100); }
  throw Error('Cold Codex resume timed out');
}

let directory, server, initial, client, tm, activity, requests = 0;
let timing;
const previousTmux = Object.fromEntries(['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR'].map(key => [key, process.env[key]]));
(async () => {
  assert.equal(process.platform, 'linux', 'This integration checks Linux /proc and tmux discovery');
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-cold-codex-'));
  const home = path.join(directory, 'codex'), project = path.join(directory, 'project');
  await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
  server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain synthetic request, never retain account data. */ }
    if (req.url !== '/v1/responses') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    const item = { type: 'message', role: 'assistant', id: 'cold-reply', content: [{ type: 'output_text', text: 'Cold resume final answer.', annotations: [] }] };
    emit({ type: 'response.created', response: { id: 'cold-response', status: 'in_progress', output: [] } });
    emit({ type: 'response.output_item.added', output_index: 0, item });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { id: 'cold-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await fs.writeFile(path.join(home, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\ncheck_for_update_on_startup = false\n[features]\nplugins = false\nin_app_updates = false\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const env = { ...process.env, CODEX_HOME: home, TMUX_TMPDIR: directory, XDG_RUNTIME_DIR: directory };
  delete env.TMUX; delete env.TMUX_PANE;
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.OPENAI_BASE_URL;
  const socket = path.join(directory, 'initial.sock');
  initial = spawn('codex', ['app-server', '--listen', `unix://${socket}`], { env, stdio: 'ignore' });
  await until(() => fs.stat(socket).then(s => s.isSocket(), () => false));
  client = new CodexRpc(); const events = [];
  client.on('message', message => events.push(message)); await client.connect(socket);
  const { thread } = await client.call('thread/start', { cwd: project, model: 'fixture-model', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'read-only', experimentalRawEvents: false, environments: [] });
  await client.call('thread/name/set', { threadId: thread.id, name: 'Cold resume fixture' });
  await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Synthetic completed turn.', text_elements: [] }] });
  await until(() => events.find(message => message.method === 'turn/completed' && message.params.threadId === thread.id));
  assert.equal(requests, 1);
  client.close(); initial.kill();
  if (initial.exitCode === null && initial.signalCode === null) await once(initial, 'exit');

  tm = (...args) => execFileSync('tmux', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
  const resumeStarted = Date.now();
  timing = { firstResponseMs: null, firstResponseStructured: false, sourceReadyMs: null, observations: [] };
  tm('new-session', '-d', '-s', 'cold-fixture', '-x', '120', '-y', '40', '-c', project, 'codex', 'resume', thread.id, '--yolo');
  const pane = () => {
    const [pid, id, ...title] = tm('list-panes', '-t', '=cold-fixture', '-F', '#{pane_pid}\t#{pane_id}\t#{pane_title}').split('\t');
    return { pid, id, title: title.join('\t') };
  };
  const observer = new LinuxCodexObserver();
  const observe = observer.observe.bind(observer);
  observer.observe = async (...args) => {
    const result = await observe(...args);
    timing.observations.push({ atMs: Date.now() - resumeStarted, detected: result.detected,
      titleReady: args[1].endsWith('Cold resume fixture | project'), bound: Boolean(result.path) });
    return result;
  };
  const session = { name: 'cold-fixture', shell: 'codex', status: 'running' };
  const manager = new EventEmitter(); manager.sessions = new Map([[session.name, session]]); manager.serialize = s => s;
  manager.on('session:activity', () => {
    if (session.activity?.available && timing.sourceReadyMs === null) timing.sourceReadyMs = Date.now() - resumeStarted;
  });
  // Every ordinary activity poll and footer capture in this standalone test
  // process must use its private tmux server, never the user's live panes.
  process.env.TMUX_TMPDIR = directory; delete process.env.TMUX; delete process.env.TMUX_PANE;
  activity = new CodexActivity(manager, { observer });
  const mobileManager = { activity, ensurePane: async () => {}, getSession: () => session, history: async () => ({ text: tm('capture-pane', '-p', '-t', pane().id) }) };
  // The first request waits through normal source warm-up. Under load a fresh
  // managed daemon may exceed the bounded wait; it must still recover from
  // ordinary background observations without any user input or forced poll.
  const answerPending = SessionManager.prototype.mobile.call(mobileManager, session.name, false);
  const initialFull = await SessionManager.prototype.mobile.call(mobileManager, session.name, true);
  assert.equal(typeof initialFull.text, 'string', 'Full remains available during source warm-up');
  const firstAnswer = await answerPending;
  timing.firstResponseMs = Date.now() - resumeStarted;
  timing.firstResponseStructured = Array.isArray(firstAnswer.messages);
  if (!timing.firstResponseStructured) {
    assert.equal(typeof firstAnswer.text, 'string', 'Bounded source wait keeps terminal output available');
    timing.firstTerminalHasReply = firstAnswer.text.includes('Cold resume final answer.');
    timing.firstTerminalResuming = firstAnswer.text.includes('Resuming session');
  }
  await until(() => session.activity?.available && activity.messages(session.name)?.some(message => message.text === 'Cold resume final answer.'));
  const answer = timing.firstResponseStructured ? firstAnswer : await SessionManager.prototype.mobile.call(mobileManager, session.name, false);
  assert.equal(session.activity.phase, 'completed'); assert.equal(session.activity.busy, false);
  assert(activity.messages(session.name).some(message => message.text === 'Cold resume final answer.'));
  const full = await SessionManager.prototype.mobile.call(mobileManager, session.name, true);
  assert(answer.messages.some(message => message.text === 'Cold resume final answer.'));
  assert.equal(answer.completed, session.activity.completed);
  assert.equal(full.messages, undefined); assert(full.text.includes('Cold resume final answer.'));
  const freshObserver = new LinuxCodexObserver(); await freshObserver.begin();
  const p = pane(); assert((await freshObserver.observe(p.pid, p.title)).path, 'No prior observer state is required');
  assert.equal(requests, 1, 'Opening, resuming and switching views must never send a new model input');
  console.log('Installed Codex cold resume timings:', JSON.stringify(timing));
  console.log('Installed Codex cold resume: bounded first request, passive daemon recovery, idle final reply, completion and answer/full passed without new input.');
})().catch(error => { if (timing) console.error('Cold resume timing at failure:', JSON.stringify(timing)); console.error(error); process.exitCode = 1; }).finally(async () => {
  activity?.close(); client?.close(); initial?.kill();
  try { tm?.('kill-server'); } catch {}
  // Managed daemons survive their last TUI. Stop only this fixture's binaries.
  if (directory) for (const pid of await fs.readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const executable = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')[0];
      if (executable.startsWith(directory + path.sep) && executable.endsWith('/bin/codex')) process.kill(Number(pid), 'SIGTERM');
    } catch { /* Exited processes do not need cleanup. */ }
  }
  server?.closeAllConnections(); server?.close();
  for (const [key, value] of Object.entries(previousTmux)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await delay(300); if (directory) await fs.rm(directory, { recursive: true, force: true });
});
