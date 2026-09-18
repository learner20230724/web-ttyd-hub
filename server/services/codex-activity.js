// Linux adapter: observe the rollout actually opened by a pane's Codex process.
// Never guess completion from silence; no hooks/config changes or transcript copies.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function applyEvent(state, event) {
  const p = event.payload || {};
  if (event.type === 'event_msg') {
    if (p.type === 'task_started') { state.busy = true; state.turn = p.turn_id; }
    if (['task_complete', 'turn_aborted'].includes(p.type) && (!p.turn_id || !state.turn || p.turn_id === state.turn)) {
      state.busy = false;
      if (p.type === 'task_complete') state.completed = `${event.timestamp}:${p.turn_id || ''}`;
    }
  }
  if (event.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role) && !['analysis', 'summary'].includes(p.channel)) {
    const text = (p.content || []).filter(x => ['input_text', 'output_text'].includes(x.type)).map(x => x.text).join('\n');
    if (text && !text.startsWith('<environment_context>')) {
      state.messages.push({ role: p.role, text, id: `${event.timestamp}:${state.sequence++}` });
      if (state.messages.length > 300) state.messages.shift();
    }
  }
}
async function findRollout(pid, depth = 0) {
  if (depth > 6) return null;
  try {
    const comm = await fs.readFile(`/proc/${pid}/comm`, 'utf8');
    if (comm.trim().includes('codex')) {
      for (const fd of await fs.readdir(`/proc/${pid}/fd`)) {
        try {
          const path = await fs.readlink(`/proc/${pid}/fd/${fd}`);
          if (/\/sessions\/.*\/rollout-[^/]+\.jsonl$/.test(path)) return path;
        } catch {}
      }
    }
    const children = (await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    for (const child of children) { const found = await findRollout(child, depth + 1); if (found) return found; }
  } catch {}
  return null;
}
class CodexActivity {
  constructor(manager) {
    this.manager = manager; this.states = new Map(); this.polling = false;
    this.timer = setInterval(() => this.poll(), 1500); this.timer.unref();
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const { stdout } = await run('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'], { timeout: 3000 });
      const panes = new Map(stdout.trim().split('\n').map(line => line.split('\t')));
      for (const session of this.manager.sessions.values()) {
        const old = JSON.stringify(session.activity);
        const path = session.status === 'running' && panes.has(session.name) ? await findRollout(panes.get(session.name)) : null;
        if (!path) {
          this.states.delete(session.name);
          session.activity = { available: false, busy: false, completed: session.activity?.completed || null };
        } else {
          let state = this.states.get(session.name);
          const stat = await fs.stat(path);
          if (!state || state.path !== path || stat.size < state.offset) {
            state = { path, offset: 0, busy: false, completed: null, messages: [], sequence: 0 };
            this.states.set(session.name, state);
          }
          if (stat.size > state.offset) {
            // Only consume complete lines; the writer may be midway through a JSON record.
            const stream = createReadStream(path, { start: state.offset, end: stat.size - 1 });
            const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
            let consumed = 0;
            for await (const line of lines) {
              const bytes = Buffer.byteLength(line) + 1;
              if (state.offset + consumed + bytes > stat.size) break;
              consumed += bytes;
              try { applyEvent(state, JSON.parse(line)); } catch {}
            }
            state.offset += consumed;
          }
          session.activity = { available: true, busy: state.busy, completed: state.completed };
        }
        if (JSON.stringify(session.activity) !== old) this.manager.emit('session:activity', this.manager.serialize(session));
      }
      for (const name of this.states.keys()) if (!this.manager.sessions.has(name)) this.states.delete(name);
    } catch { /* tmux may not exist yet; unavailable is never reported as busy. */ }
    finally { this.polling = false; }
  }
  messages(name) { return this.states.get(name)?.messages || null; }
  close() { clearInterval(this.timer); }
}
module.exports = { CodexActivity, applyEvent };
