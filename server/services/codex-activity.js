// Observe only a rollout bound to this pane, including shared-daemon Codex.
// Never guess completion from silence; no hooks/config changes or transcript copies.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { LinuxCodexObserver, resolveRollout, terminalStatus } = require('./codex-observer');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function setPhase(state, phase, timestamp) {
  state.phase = phase;
  state.busy = ['working', 'thinking', 'responding', 'executing', 'waiting', 'retrying'].includes(phase);
  if (timestamp) state.updatedAt = timestamp;
}
function message(state, value) {
  state.messages ||= [];
  state.sequence ||= 0;
  state.messages.push({ ...value, id: `${value.timestamp || ''}:${state.sequence++}` });
  if (state.messages.length > 300) state.messages.shift();
}

function dialogueText(text, role) {
  if (typeof text !== 'string' || /^(?:<environment_context>|# AGENTS\.md instructions\b)/.test(text)) return '';
  // The CLI persists asynchronous question replies in a transport envelope.
  // Its question IDs and JSON are not part of what the user wrote.
  const envelope = role === 'user' && /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text.trim());
  if (envelope) try {
    const replies = JSON.parse(envelope[1]);
    if (Array.isArray(replies) && replies.length && replies.every(reply => typeof reply?.answer === 'string')) {
      return replies.map(reply => reply.answer).join('\n\n');
    }
  } catch { /* Preserve ordinary or malformed user text instead of losing it. */ }
  return text;
}

function applyEvent(state, event) {
  const p = event.payload || {};
  const at = event.timestamp;
  const matchesTurn = !p.turn_id || !state.turn || p.turn_id === state.turn;
  if (event.type === 'event_msg') {
    if (p.type === 'task_started' && !(state.busy && state.turn === p.turn_id)) {
      state.turn = p.turn_id; state.error = null; state.completed = null;
      state.startedAt = at; state.pendingTools = new Map(); state.inputRequests = new Set();
      setPhase(state, 'working', at);
    }
    if (matchesTurn && ['task_complete', 'task_completed', 'turn_aborted', 'turn_failed'].includes(p.type)) {
      const failed = Boolean(p.error) || p.status === 'failed' || p.type === 'turn_failed' || state.phase === 'error';
      const interrupted = p.type === 'turn_aborted' || ['interrupted', 'cancelled'].includes(p.status);
      state.completed = null;
      state.pendingTools?.clear(); state.inputRequests?.clear();
      setPhase(state, failed ? 'error' : interrupted ? 'interrupted' : 'completed', at);
      if (failed) {
        state.error = typeof p.error === 'string' ? p.error : p.error?.message || state.error || 'Codex 调用失败，请查看全文';
        message(state, { role: 'assistant', text: 'Codex 调用失败：\n\n' + state.error, phase: 'error', timestamp: at });
      } else if (!interrupted) state.completed = `${at}:${p.turn_id || ''}`;
    }
    if (matchesTurn && state.busy) {
      if (['exec_approval_request', 'apply_patch_approval_request', 'request_user_input', 'elicitation_request'].includes(p.type)) setPhase(state, 'waiting', at);
      if (p.type === 'stream_error') setPhase(state, 'retrying', at);
      if (p.type === 'error') {
        state.error = p.message || p.error?.message || 'Codex 调用失败，请查看全文';
        setPhase(state, p.will_retry ? 'retrying' : 'error', at);
      }
      if (p.type === 'item_completed') {
        const kind = p.item?.type;
        if (kind === 'Reasoning') setPhase(state, 'thinking', at);
        if (kind === 'AgentMessage') setPhase(state, 'responding', at);
      }
    }
  }
  if (event.type === 'response_item') {
    // Question replies are tool results, not ordinary user messages. Retain only
    // their accepted answer text for delivery receipts, never general tool output.
    if (p.type === 'function_call' && /^(?:functions\.)?request_user_input$/.test(p.name || '') && p.call_id) {
      state.inputRequests ||= new Set();
      state.inputRequests.add(p.call_id);
      if (state.inputRequests.size > 128) state.inputRequests.delete(state.inputRequests.values().next().value);
    }
    if (state.busy && ['function_call', 'custom_tool_call'].includes(p.type)) {
      state.pendingTools ||= new Map();
      const phase = state.inputRequests?.has(p.call_id) ? 'waiting' : 'executing';
      if (p.call_id) state.pendingTools.set(p.call_id, phase);
      setPhase(state, [...state.pendingTools.values()].includes('waiting') ? 'waiting' : phase, at);
    }
    if (p.type === 'function_call_output' && state.inputRequests?.delete(p.call_id)) {
      try {
        const result = typeof p.output === 'string' ? JSON.parse(p.output) : p.output;
        for (const [question, value] of Object.entries(result?.answers || {})) {
          if (!Array.isArray(value?.answers)) continue;
          value.answers.forEach((answer, index) => {
            if (typeof answer !== 'string') return;
            const text = answer.replace(/^user_note: ?/, '');
            if (!text.trim() || Buffer.byteLength(text) > 64000) return;
            state.inputReceipts ||= [];
            state.inputReceipts.push({ id: `answer:${p.call_id}:${question}:${index}`, text });
            if (state.inputReceipts.length > 300) state.inputReceipts.shift();
          });
        }
      } catch { /* Partial/malformed results cannot confirm delivery. */ }
    }
    if (state.busy && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      state.pendingTools?.delete(p.call_id);
      setPhase(state, [...(state.pendingTools?.values() || [])].includes('waiting') ? 'waiting' : state.pendingTools?.size ? 'executing' : 'working', at);
    }
    if (state.busy && !state.pendingTools?.size && p.type === 'reasoning') setPhase(state, 'thinking', at);
    if (state.busy && p.type === 'message' && p.role === 'assistant' && !['analysis', 'summary'].includes(p.channel)) setPhase(state, 'responding', at);
  }
  if (event.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role) && !['analysis', 'summary'].includes(p.channel)) {
    const text = (p.content || []).filter(x => ['input_text', 'output_text'].includes(x.type)).map(x => dialogueText(x.text, p.role)).filter(Boolean).join('\n');
    if (text && !text.startsWith('<environment_context>')) {
      message(state, { role: p.role, text, timestamp: at, ...(p.phase ? { phase: p.phase } : {}) });
    }
  }
}

async function consumeRollout(state, size) {
  if (size <= state.offset) return;
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(state.path, { start: state.offset, end: size - 1 })) {
    pending = Buffer.concat([pending, chunk]);
    let start = 0, newline;
    while ((newline = pending.indexOf(10, start)) !== -1) {
      const line = pending.subarray(start, newline).toString('utf8');
      state.offset += newline - start + 1; start = newline + 1;
      try { applyEvent(state, JSON.parse(line)); } catch { /* Ignore malformed records, not following valid lines. */ }
    }
    pending = pending.subarray(start);
  }
  // No offset advance for partial records. Byte counting supports CRLF and UTF-8.
}
class CodexActivity {
  constructor(manager, { observer = new LinuxCodexObserver(), interval = 1500 } = {}) {
    this.manager = manager; this.states = new Map(); this.polling = null; this.updates = new Map();
    this.questions = new (require('./codex-questions').CodexQuestions)(this);
    this.usage = new (require('./codex-usage').CodexUsage)();
    this.observer = observer;
    this.timer = setInterval(() => this.poll(), interval); this.timer.unref();
  }
  publish(session, activity) {
    if (JSON.stringify(session.activity) === JSON.stringify(activity)) return;
    session.activity = activity;
    this.manager.emit('session:activity', this.manager.serialize(session));
  }
  async update(session, pane, windowsPaths) {
    const previous = this.updates.get(session.name) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.updateState(session, pane, windowsPaths));
    this.updates.set(session.name, task);
    try { await task; } finally { if (this.updates.get(session.name) === task) this.updates.delete(session.name); }
  }
  async updateState(session, pane, windowsPaths) {
    try {
      const observed = session.status !== 'running' || !pane ? { detected: false, path: null }
        : windowsPaths ? { detected: Boolean(windowsPaths[pane.pid]), path: await resolveRollout(windowsPaths[pane.pid] || [], '', false) }
        : await this.observer.observe(pane.pid, pane.title);
      const filename = observed.path;
      let screenPhase = null;
      const readScreen = async () => {
        if (!observed.detected || process.platform === 'win32') return;
        // The footer supplements approval/retry status. A resize, detached pane
        // or capture timeout cannot invalidate a verified rollout or its replies.
        try {
          const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', pane.id], { timeout: 1000, maxBuffer: 1024 * 1024 });
          screenPhase = terminalStatus(stdout);
        } catch { /* Structured task events and dialogue remain authoritative. */ }
      };
      if (!filename) {
        await readScreen();
        this.states.delete(session.name);
        this.publish(session, { available: false, detected: observed.detected, busy: Boolean(screenPhase), phase: screenPhase || 'unknown', completed: null, source: screenPhase ? 'terminal' : null });
        return;
      }
      const threadId = filename.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1];
      if (threadId && threadId !== session.codexThreadId) {
        session.codexThreadId = threadId;
        this.manager.emit('session:identity', this.manager.serialize(session));
      }
      let state = this.states.get(session.name);
      const stat = await fs.stat(filename);
      const identity = `${stat.dev}:${stat.ino}`;
      if (!state || state.path !== filename || state.identity !== identity || stat.size < state.offset) {
        state = { path: filename, identity, offset: 0, busy: false, phase: 'idle', completed: null, messages: [], sequence: 0 };
        this.states.set(session.name, state);
      }
      await consumeRollout(state, stat.size);
      state.binding = threadId && observed.socket ? { threadId, socket: observed.socket, checkedAt: Date.now() } : null;
      if (state.busy) await readScreen();
      // Approval dialogs aren't always persisted. Only a live footer can override
      // a working turn; it cannot turn an explicit completion into a new turn.
      const phase = this.questions.hasBlocking(threadId) ? 'waiting' : state.busy && ['waiting', 'retrying'].includes(screenPhase) ? screenPhase : state.phase;
      this.publish(session, { available: true, detected: true, busy: phase === 'waiting' || state.busy, phase, completed: phase === 'waiting' ? null : state.completed,
        source: 'rollout', startedAt: state.startedAt || null, updatedAt: state.updatedAt || null,
        ...(state.error ? { error: state.error } : {}) });
    } catch {
      // Isolate errors per pane. Never leave an old green/busy lamp looking live.
      this.states.delete(session.name);
      this.publish(session, { available: false, busy: false, phase: 'unknown', completed: null, source: null });
    }
  }
  poll() {
    if (!this.polling) this.polling = this.pollSessions().finally(() => { this.polling = null; });
    return this.polling;
  }
  async pollSessions() {
    try {
      let panes, windowsPaths;
      if (process.platform === 'win32') {
        panes = new Map([...this.manager.sessions.values()].filter(s => s.status === 'running' && s.pid).map(s => [s.name, String(s.pid)]));
        panes = new Map([...panes].map(([name, pid]) => [name, { pid }]));
        const { stdout } = await run(process.env.HUB_PYTHON || 'python', [require('node:path').join(__dirname, '../../scripts/windows-rollouts.py'), ...[...panes.values()].map(p => p.pid)], { timeout: 8000, windowsHide: true, encoding: 'utf8' });
        windowsPaths = JSON.parse(stdout);
      } else {
        const { stdout } = await run('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_id}\t#{pane_title}'], { timeout: 3000 });
        panes = new Map(stdout.trim().split('\n').map(line => { const [name, pid, id, ...title] = line.split('\t'); return [name, { pid, id, title: title.join('\t') }]; }));
        await this.observer.begin();
      }
      await Promise.all([...this.manager.sessions.values()].map(session => this.update(session, panes.get(session.name), windowsPaths)));
      for (const name of this.states.keys()) if (!this.manager.sessions.has(name)) this.states.delete(name);
    } catch {
      for (const session of this.manager.sessions.values()) this.publish(session, { available: false, busy: false, phase: 'unknown', completed: null, source: null });
    }
  }
  messages(name) { return this.states.get(name)?.messages || null; }
  inputReceipts(name) { return this.states.get(name)?.inputReceipts || []; }
  binding(name) {
    const session = this.manager.sessions.get(name), binding = this.states.get(name)?.binding;
    return session?.status === 'running' && !session.archivedAt && binding && Date.now() - binding.checkedAt < 5000 ? binding : null;
  }
  async verifyBinding(name) {
    if (process.platform === 'win32') return null;
    const session = this.manager.getSession(name);
    if (session.status !== 'running' || session.archivedAt) return null;
    const { stdout } = await run('tmux', ['list-panes', '-t', `=${name}`, '-F', '#{pane_pid}\t#{pane_id}\t#{pane_title}'], { timeout: 3000 });
    const rows = stdout.trim().split('\n');
    if (rows.length !== 1) return null;
    const [pid, id, ...title] = rows[0].split('\t');
    await this.observer.begin();
    await this.update(session, { pid, id, title: title.join('\t') });
    return this.binding(name);
  }
  close() { clearInterval(this.timer); this.questions.close(); this.usage.close(); }
}
module.exports = { CodexActivity, applyEvent, consumeRollout };
