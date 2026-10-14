const { randomUUID } = require('node:crypto');
const { CodexRpc } = require('./codex-rpc');

const failure = (message, status = 409) => Object.assign(new Error(message), { status });
function questionsFrom(params) {
  if (!Array.isArray(params?.questions) || !params.questions.length || params.questions.length > 20) return null;
  const ids = new Set();
  for (const q of params.questions) {
    if (!q || typeof q.id !== 'string' || ids.has(q.id) || typeof q.question !== 'string' || q.question.length > 20000) return null;
    ids.add(q.id);
    if (q.options != null && (!Array.isArray(q.options) || q.options.length > 100 || q.options.some(o => typeof o?.label !== 'string' || typeof o?.description !== 'string'))) return null;
  }
  return params.questions.map(q => ({ id: q.id, header: q.header || '', question: q.question, isSecret: q.isSecret === true, options: q.options || [] }));
}
function answerResult(questions, input) {
  if (!input || !['answer', 'skip'].includes(input.action)) throw failure('请选择提交回答或跳过', 400);
  if (input.action === 'skip') return { answers: Object.fromEntries(questions.map(q => [q.id, { answers: [] }])) };
  if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) throw failure('请填写回答', 400);
  if (Object.keys(input.answers).some(id => !questions.some(q => q.id === id))) throw failure('问题已改变，请刷新', 400);
  let total = 0;
  const entries = questions.map(q => {
    const text = input.answers[q.id];
    if (typeof text !== 'string' || !text.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw failure('请回答每个问题，或选择跳过本次追问', 400);
    total += Buffer.byteLength(text);
    if (total > 64000) throw failure('回答过长，请缩短后提交', 400);
    return [q.id, { answers: [text.trim()] }];
  });
  return { answers: Object.fromEntries(entries) };
}

class CodexQuestions {
  constructor(activity, { createRpc = () => new CodexRpc(), idleMs = 120000 } = {}) {
    this.activity = activity; this.createRpc = createRpc; this.connections = new Map();
    this.timer = setInterval(() => {
      for (const entry of this.connections.values()) if (Date.now() - entry.usedAt > idleMs) entry.rpc.close();
    }, 30000); this.timer.unref();
  }
  async connection(socket) {
    let entry = this.connections.get(socket);
    if (!entry) {
      const rpc = this.createRpc();
      entry = { rpc, requests: new Map(), attached: new Map(), usedAt: Date.now() };
      this.connections.set(socket, entry);
      rpc.on('close', () => {
        if (this.connections.get(socket) === entry) this.connections.delete(socket);
        entry.requests.clear();
      });
      rpc.on('message', message => this.receive(entry, message));
      entry.ready = rpc.connect(socket).catch(err => { rpc.close(); throw err; });
    }
    entry.usedAt = Date.now(); await entry.ready; return entry;
  }
  receive(entry, message) {
    const p = message.params || {};
    if (message.method === 'item/tool/requestUserInput' && message.id != null && entry.attached.has(p.threadId)) {
      const questions = questionsFrom(p);
      if (questions && !entry.requests.has(message.id)) entry.requests.set(message.id, {
        token: randomUUID(), requestId: message.id, threadId: p.threadId, turnId: p.turnId, questions, isBlocking: p.isBlocking !== false, submitting: false,
      });
    }
    if (message.method === 'serverRequest/resolved') {
      const request = entry.requests.get(p.requestId);
      if (request && request.threadId === p.threadId) {
        entry.requests.delete(p.requestId); request.resolve?.();
      }
    }
    if (['thread/closed', 'thread/archived', 'turn/completed', 'turn/aborted'].includes(message.method)) {
      for (const [id, request] of entry.requests) if (request.threadId === p.threadId && (!p.turn?.id || p.turn.id === request.turnId)) {
        entry.requests.delete(id); request.reject?.(failure('追问已结束，请查看最新回复'));
      }
      if (message.method.startsWith('thread/')) entry.attached.delete(p.threadId);
    }
  }
  async read(name) {
    const binding = this.activity.binding(name);
    if (!binding) return { supported: false, requests: [] };
    try {
      const entry = await this.connection(binding.socket);
      if (!entry.attached.has(binding.threadId)) {
        // Register before resuming: pending requests are replayed during the response.
        const attachment = entry.rpc.call('thread/resume', { threadId: binding.threadId, excludeTurns: true }, 8000);
        entry.attached.set(binding.threadId, attachment);
        try { await attachment; } catch (err) { entry.attached.delete(binding.threadId); throw err; }
      } else await entry.attached.get(binding.threadId);
      if (this.activity.binding(name)?.threadId !== binding.threadId) return { supported: false, requests: [] };
      return { supported: true, requests: [...entry.requests.values()].filter(q => q.threadId === binding.threadId).map(q => ({ id: q.token, questions: q.questions, isBlocking: q.isBlocking, submitting: q.submitting })) };
    } catch { return { supported: false, requests: [], message: '追问连接暂不可用，可切换全文操作。' }; }
  }
  async respond(name, token, input) {
    const binding = await this.activity.verifyBinding(name);
    const entry = binding && this.connections.get(binding.socket);
    const request = entry && [...entry.requests.values()].find(q => q.token === token && q.threadId === binding.threadId);
    if (!request) throw failure('追问已结束或会话已切换，请查看最新内容');
    if (request.submitting) throw failure('回答正在提交，请勿重复操作');
    const result = answerResult(request.questions, input);
    request.submitting = true; entry.usedAt = Date.now();
    // Wait for serverRequest/resolved, not just a successful socket write.
    let cleanup = () => {};
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => request.reject(failure('未确认回答是否送达，请查看全文后再操作')), 8000);
        const disconnected = () => request.reject(failure('连接已断开，回答结果未确认，请查看全文'));
        entry.rpc.once('close', disconnected);
        cleanup = () => { clearTimeout(timer); entry.rpc.off('close', disconnected); };
        const finish = fn => value => { cleanup(); fn(value); };
        request.resolve = finish(resolve); request.reject = finish(reject);
        try { entry.rpc.send({ id: request.requestId, result }); }
        catch (err) { request.reject(err); }
      });
      return { ok: true };
    } finally {
      cleanup();
      delete request.resolve; delete request.reject;
      // An uncertain send must never automatically resend. Reattach to replay
      // only requests still open upstream before the user can try again.
      if (entry.requests.has(request.requestId)) entry.rpc.close();
    }
  }
  hasBlocking(threadId) {
    return [...this.connections.values()].some(entry => [...entry.requests.values()].some(q => q.threadId === threadId && q.isBlocking));
  }
  close() { clearInterval(this.timer); for (const entry of this.connections.values()) entry.rpc.close(); }
}
module.exports = { CodexQuestions, questionsFrom, answerResult };
