// Installed Codex + the production tmux paste/key/history pipeline. All input
// stays in a private tmux server and credential-free home with a local provider.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, describe) {
  for (let i = 0; i < 150; i++) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Installed Codex command timed out: ${describe}`);
}

async function worker() {
  // The parent installs the private environment before this module is loaded,
  // including SessionManager's captured spawn environment and raw child spawns.
  const SessionManager = require('../server/services/session-manager');
  const directory = process.argv[3];
  const name = 'command-fixture';
  const target = `=${name}:`;
  const tm = (...args) => execFileSync('tmux', args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  const manager = Object.create(SessionManager.prototype);
  manager.sessions = new Map([[name, { name, shell: 'codex', status: 'running', cwd: directory }]]);
  manager.inputQueues = new Map(); manager.paneStarts = new Map();
  const screen = () => manager.history(name).then(value => value.text);
  const input = value => manager.input(name, value);
  const selectedModel = text => text.split('\n').find(line => /^\s*›\s*\d+\./u.test(line));
  let lastScreen = '';
  async function visible(pattern, describe) {
    return until(async () => { lastScreen = await screen(); return pattern.test(lastScreen) && lastScreen; }, describe);
  }
  try {
    tm('new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', directory,
      'codex', '--no-daemon', '--no-alt-screen', '-a', 'never', '-s', 'read-only', '-C', directory);
    const panePid = tm('display-message', '-p', '-t', target, '#{pane_pid}');
    await visible(/fixture-model/, 'initial prompt');
    await input({ text: '/status', key: 'Enter' });
    await visible(/Model provider:\s*fixture/, '/status output');

    await input({ text: '/model', key: 'Enter' });
    const models = await visible(/Select Model and Effort/, '/model picker');
    const initialSelection = selectedModel(models);
    assert(initialSelection, 'The real model picker has a selected row');
    await input({ key: 'Down' });
    const moved = await until(async () => {
      lastScreen = await screen();
      const selected = selectedModel(lastScreen);
      return selected && selected !== initialSelection && selected;
    }, 'model picker Down redraw');
    await input({ key: 'Up' });
    await until(async () => { lastScreen = await screen(); return selectedModel(lastScreen) === initialSelection; }, 'model picker Up redraw');
    assert.notEqual(moved, initialSelection);
    await input({ key: 'Enter' });
    await visible(/Select Reasoning (?:Effort|Level)/, 'model picker Enter opens effort selection');
    await input({ key: 'Escape' });
    await input({ key: 'Escape' });
    await until(async () => { lastScreen = await screen(); return !/Select Model and Effort|Select Reasoning (?:Effort|Level)/.test(lastScreen); }, 'Escape closes model menus');

    await input({ text: '/resume', key: 'Enter' });
    await visible(/Resume a previous session/, '/resume picker');
    await input({ key: 'Down' }); await input({ key: 'Up' });
    await input({ key: 'Escape' });
    await until(async () => { lastScreen = await screen(); return !/Resume a previous session/.test(lastScreen); }, 'Escape closes resume picker');

    const beforePaste = (await screen()).match(/Model provider:/g)?.length || 0;
    await input({ text: '/status', key: null });
    await visible(/›\s*\/status/u, 'paste-only stays in terminal composer');
    await delay(600);
    assert.equal(((await screen()).match(/Model provider:/g) || []).length, beforePaste,
      'Paste-only must not execute the command or append an implicit Enter');
    await input({ key: 'Enter' });
    await until(async () => {
      lastScreen = await screen();
      return (lastScreen.match(/Model provider:/g) || []).length === beforePaste + 1;
    }, 'separate Enter executes pasted command exactly once');
    assert.equal(manager.inputQueues.size, 0);
    assert.equal(tm('display-message', '-p', '-t', target, '#{pane_pid}'), panePid,
      'All commands and redraws used the original isolated terminal process');

    let userMessages = 0, modelTurns = 0;
    async function walk(folder) {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.name.endsWith('.jsonl')) for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'response_item' && event.payload?.role === 'user') userMessages++;
          if (event.type === 'event_msg' && event.payload?.type === 'task_started') modelTurns++;
        }
      }
    }
    await walk(process.env.CODEX_HOME);
    assert.equal(userMessages, 0, 'Local slash commands have no matching user transcript receipt');
    assert.equal(modelTurns, 0, 'Navigation and local commands must not start model turns');
    console.log('Production input pipeline: /status, /model, /resume, Down/Up/Enter/Escape, paste-only, separate Enter and terminal redraw passed; zero transcript user messages/model turns.');
  } catch (error) {
    if (lastScreen) console.error('Synthetic terminal at failure:\n' + lastScreen);
    throw error;
  } finally { try { tm('kill-server'); } catch { /* The isolated server may already have exited. */ } }
}

async function integration() {
  assert.equal(process.platform, 'linux', 'The installed Codex/tmux integration runs on Linux');
  let directory, child, childTimeout, env, modelRequests = 0, providerRequests = 0;
  const provider = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Synthetic requests only; no credentials or prompts retained. */ }
    providerRequests++;
    if (req.url === '/v1/responses') modelRequests++;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}');
  });
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-command-codex-'));
    const codexHome = path.join(directory, 'codex'); await fs.mkdir(codexHome);
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    await fs.writeFile(path.join(codexHome, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\ncheck_for_update_on_startup = false\n[features]\nplugins = false\nin_app_updates = false\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`);
    env = { PATH: process.env.PATH, HOME: directory, CODEX_HOME: codexHome, TMUX_TMPDIR: directory,
      XDG_RUNTIME_DIR: directory, LANG: 'C.UTF-8', TERM: 'xterm-256color' };
    child = spawn(process.execPath, [__filename, '--fixture-worker', directory], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    childTimeout = setTimeout(() => child.kill('SIGTERM'), 90000);
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, 'Isolated command test must finish before its deadline');
    assert.equal(code, 0, 'Production input pipeline fixture must pass');
    assert.equal(modelRequests, 0, 'Local terminal commands make no model API requests');
    assert.equal(providerRequests, 0, 'This local command/menu scenario needs no provider calls');
    console.log('Installed Codex local command integration passed with zero provider/model requests.');
  } finally {
    clearTimeout(childTimeout); child?.kill();
    if (env) try { execFileSync('tmux', ['kill-server'], { env, timeout: 5000, stdio: 'ignore' }); } catch { /* Already stopped. */ }
    provider.closeAllConnections(); provider.close();
    await delay(300); if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

(process.argv[2] === '--fixture-worker' ? worker() : integration()).catch(error => { console.error(error); process.exitCode = 1; });
