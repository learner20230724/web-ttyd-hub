const { CodexRpc } = require('./codex-rpc');

function normalizeUsage(result) {
  const map = result?.rateLimitsByLimitId;
  const limits = map && Object.keys(map).length ? Object.entries(map) : [['codex', result?.rateLimits]];
  const windows = [];
  for (const [poolId, limit] of limits) {
    if (!limit) continue;
    for (const key of ['primary', 'secondary']) {
      const window = limit[key];
      if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
      const minutes = window.windowDurationMins;
      const period = minutes === 10080 ? '每周额度' : minutes === 300 ? '5 小时额度' : minutes > 0 ? (minutes % 1440 === 0 ? `${minutes / 1440} 天额度` : minutes % 60 === 0 ? `${minutes / 60} 小时额度` : `${minutes} 分钟额度`) : '使用额度';
      const reset = Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? new Date(window.resetsAt * 1000) : null;
      const limitId = limit.limitId || poolId;
      windows.push({ id: `${limitId}:${key}`, name: limit.limitName || (limitId !== 'codex' ? limitId : 'Codex'), period,
        remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)), resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null });
    }
  }
  return { available: windows.length > 0, windows };
}

class CodexUsage {
  constructor({ createRpc = () => new CodexRpc(), now = Date.now } = {}) { this.createRpc = createRpc; this.now = now; }
  async read(force = false) {
    if (this.inflight) return this.inflight;
    // Coalesce taps and polls; errors also back off rather than spawning processes.
    if (this.last && this.now() - this.lastAttempt < (force ? 5000 : 60000)) return this.last;
    this.lastAttempt = this.now();
    this.inflight = (async () => {
      const rpc = this.createRpc(); this.rpc = rpc;
      try {
        await rpc.connect();
        const usage = normalizeUsage(await rpc.call('account/rateLimits/read', {}));
        this.last = { ...usage, stale: false, fetchedAt: new Date(this.now()).toISOString(), message: usage.available ? '' : '当前账号未提供额度数据，请在 Codex 中确认登录方式。' };
      } catch {
        this.last = { ...(this.last || { available: false, windows: [], fetchedAt: null }), stale: true, message: '暂时无法读取账号额度，请稍后刷新；也可在 Codex 中使用 /status 查看。' };
      } finally { rpc.close(); this.rpc = null; }
      return this.last;
    })();
    try { return await this.inflight; } finally { this.inflight = null; }
  }
  close() { this.rpc?.close(); }
}
module.exports = { CodexUsage, normalizeUsage };
