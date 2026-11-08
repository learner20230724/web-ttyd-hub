const { createHash } = require('node:crypto');
// Shared by every client of this Hub (the Hub has no per-user accounts).
// Mutate individual intentions, never replace state with a device's snapshot.
const validName = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validRevision = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validNames = value => Array.isArray(value) && value.length <= 1000 && value.every(validName) && new Set(value).size === value.length;
const validLayout = value => value && validNames(value.order) && validNames(value.pinned) && (value.manual === undefined || typeof value.manual === 'boolean');
const empty = () => ({ revision: 0, read: {}, layout: null });

class SessionSync {
  constructor(manager) { this.manager = manager; this.value = empty(); }
  static validate(value) {
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !value.read || typeof value.read !== 'object' || Array.isArray(value.read) ||
        (value.layout !== null && !validLayout(value.layout)) ||
        (value.operations !== undefined && (!Array.isArray(value.operations) || value.operations.length > 4096 || value.operations.some(x => !x || typeof x.id !== 'string' || !/^[a-f0-9]{64}$/.test(x.hash) || !Number.isSafeInteger(x.issuedAt)))) ||
        !Object.entries(value.read).every(([name, marker]) => validName(name) && marker && validTime(marker.createdAt) &&
          typeof marker.completed === 'string' && marker.completed.length > 0 && marker.completed.length <= 1000 &&
          (marker.contentRevision === undefined || validRevision(marker.contentRevision)))) {
      throw new Error('Invalid shared session state; refusing to overwrite state');
    }
    return value;
  }
  restore(value) { this.value = value == null ? empty() : SessionSync.validate(value); }
  durable() { return this.value; }
  snapshot() { const { operations, ...publicState } = this.value; return publicState; }
  prune() {
    const names = this.manager.sessions;
    const previous = this.value;
    this.value = { ...this.value,
      read: Object.fromEntries(Object.entries(this.value.read).filter(([name, marker]) => names.get(name)?.createdAt === marker.createdAt)),
      layout: this.value.layout && { ...this.value.layout, order: this.value.layout.order.filter(name => names.has(name)), pinned: this.value.layout.pinned.filter(name => names.has(name)) } };
    if (JSON.stringify(previous) !== JSON.stringify(this.value)) this.value.revision++;
  }
  apply(op) {
    if (!op || !['read', 'pin', 'move', 'initialize'].includes(op.type)) throw new Error('无效的状态同步操作');
    const previous = this.value;
    let operation;
    if (op.opId !== undefined) {
      if (typeof op.opId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(op.opId) ||
          !Number.isSafeInteger(op.issuedAt) || op.issuedAt > Date.now() + 60000 || Date.now() - op.issuedAt > 7 * 86400000)
        throw new Error('操作已过期，请重新操作');
      const hash = createHash('sha256').update(JSON.stringify(op)).digest('hex');
      const seen = previous.operations?.find(x => x.id === op.opId);
      if (seen) {
        if (seen.hash !== hash) throw new Error('操作标识冲突');
        return { shared: this.snapshot(), accepted: true };
      }
      operation = { id: op.opId, hash, issuedAt: op.issuedAt };
      // Never evict a still-retryable operation: old retries could otherwise
      // overwrite later intentions. Refuse excess work until the window expires.
      if ((previous.operations || []).filter(x => Date.now() - x.issuedAt <= 7 * 86400000).length >= 4096)
        throw Object.assign(new Error('同步队列已满，请稍后重试'), { status: 503 });
    }
    let next = structuredClone(previous);
    const session = this.manager.sessions.get(op.name);
    if (op.type === 'initialize') {
      if (!validLayout(op.layout)) throw new Error('无效的会话排列');
      if (next.layout === null) {
        const exists = name => this.manager.sessions.has(name);
        next.layout = { order: op.layout.order.filter(exists), pinned: op.layout.pinned.filter(exists), ...(op.layout.manual === true ? { manual: true } : {}) };
      }
    } else {
      if (!validName(op.name) || !validTime(op.createdAt)) throw new Error('无效的会话身份');
      // Requests from sleeping devices must not affect a same-name replacement.
      if (!session || session.createdAt !== op.createdAt || session.archivedAt) return { shared: this.snapshot(), accepted: false };
      const layout = next.layout || { order: this.manager.list().map(s => s.name), pinned: [] };
      const promote = () => { layout.order = [op.name, ...layout.order.filter(name => name !== op.name)]; next.layout = layout; };
      if (op.type === 'read') {
        if (typeof op.completed !== 'string' || !op.completed || op.completed.length > 1000) throw new Error('无效的已读记录');
        if (op.contentRevision !== undefined && !validRevision(op.contentRevision)) throw new Error('无效的已读版本');
        const activity = session.activity || {};
        if (session.status !== 'running' || activity.completed !== op.completed || activity.busy || activity.available === false ||
            activity.error || ['waiting', 'error', 'interrupted', 'unknown'].includes(activity.phase) ||
            (activity.contentRevision ? op.contentRevision !== activity.contentRevision : op.contentRevision !== undefined)) return { shared: this.snapshot(), accepted: false };
        // A versioned answer can only be acknowledged at its rendered version.
        const contentRevision = validRevision(activity.contentRevision) ? activity.contentRevision : undefined;
        const marker = next.read[op.name];
        const sameTurn = marker?.createdAt === op.createdAt && marker?.completed === op.completed;
        if (!sameTurn || (contentRevision && marker?.contentRevision !== contentRevision)) {
          next.read = { ...next.read, [op.name]: { createdAt: op.createdAt, completed: op.completed,
            ...(contentRevision ? { contentRevision } : {}) } };
          // Merely binding an old already-read turn to its first known version
          // must not undo manual ordering. A newer known version is new content.
          if (!layout.manual && (!sameTurn || marker?.contentRevision !== undefined)) promote();
        }
      } else if (op.type === 'pin') {
        if (typeof op.pinned !== 'boolean') throw new Error('无效的置顶状态');
        if (layout.pinned.includes(op.name) !== op.pinned) {
          layout.pinned = op.pinned ? [...layout.pinned, op.name] : layout.pinned.filter(name => name !== op.name);
          promote();
        }
      } else {
        if (!validName(op.target) || !validTime(op.targetCreatedAt) || typeof op.after !== 'boolean') throw new Error('无效的排序目标');
        const target = this.manager.sessions.get(op.target);
        if (!target || target.createdAt !== op.targetCreatedAt || target.archivedAt || op.name === op.target ||
            layout.pinned.includes(op.name) !== layout.pinned.includes(op.target)) return { shared: this.snapshot(), accepted: false };
        const positions = new Map(layout.order.map((name, index) => [name, index]));
        const priority = s => {
          const a = s.activity?.available === false && s.lastKnownActivity ? s.lastKnownActivity : s.activity || {}, marker = next.read[s.name];
          if (s.status !== 'running') return 2;
          if (a.phase === 'waiting' || a.phase === 'error' || (a.error && !a.busy)) return -1;
          if (a.phase === 'interrupted') return 2;
          if (a.busy) return 1;
          if (a.available === false || a.phase === 'unknown') return 2;
          return a.completed && (marker?.createdAt !== s.createdAt || marker?.completed !== a.completed ||
            marker?.contentRevision && a.contentRevision && marker.contentRevision !== a.contentRevision) ? 0 : 2;
        };
        const visible = this.manager.list().sort((a,b) => Number(layout.pinned.includes(b.name)) - Number(layout.pinned.includes(a.name)) ||
          (layout.manual ? 0 : priority(a) - priority(b)) || (positions.get(a.name) ?? Infinity) - (positions.get(b.name) ?? Infinity));
        const order = visible.map(s => s.name).filter(name => name !== op.name);
        order.splice(order.indexOf(op.target) + Number(op.after), 0, op.name);
        next.layout = { ...layout, order, manual: true };
      }
    }
    if (operation) next.operations = [...(next.operations || []).filter(x => Date.now() - x.issuedAt <= 7 * 86400000), operation];
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      next.revision++;
      this.value = next;
      try { this.manager.state?.save(this.manager.list(), next); }
      catch { this.value = previous; throw Object.assign(new Error('无法保存会话状态，请稍后重试'), { status: 503 }); }
      // Persist before broadcasting so a successful receipt survives restart.
      this.manager.emit('session:sync', this.snapshot());
    }
    return { shared: this.snapshot(), accepted: true };
  }
}
module.exports = SessionSync;
