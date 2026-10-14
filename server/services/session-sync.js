// Shared by every client of this Hub (the Hub has no per-user accounts).
// Mutate individual intentions, never replace state with a device's snapshot.
const validName = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validNames = value => Array.isArray(value) && value.length <= 1000 && value.every(validName) && new Set(value).size === value.length;
const validLayout = value => value && validNames(value.order) && validNames(value.pinned);
const empty = () => ({ revision: 0, read: {}, layout: null });

class SessionSync {
  constructor(manager) { this.manager = manager; this.value = empty(); }
  static validate(value) {
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !value.read || typeof value.read !== 'object' || Array.isArray(value.read) ||
        (value.layout !== null && !validLayout(value.layout)) ||
        !Object.entries(value.read).every(([name, marker]) => validName(name) && marker && validTime(marker.createdAt) &&
          typeof marker.completed === 'string' && marker.completed.length > 0 && marker.completed.length <= 1000)) {
      throw new Error('Invalid shared session state; refusing to overwrite state');
    }
    return value;
  }
  restore(value) { this.value = value == null ? empty() : SessionSync.validate(value); }
  snapshot() { return this.value; }
  prune() {
    const names = this.manager.sessions;
    const previous = this.value;
    this.value = { ...this.value,
      read: Object.fromEntries(Object.entries(this.value.read).filter(([name, marker]) => names.get(name)?.createdAt === marker.createdAt)),
      layout: this.value.layout && { order: this.value.layout.order.filter(name => names.has(name)), pinned: this.value.layout.pinned.filter(name => names.has(name)) } };
    if (JSON.stringify(previous) !== JSON.stringify(this.value)) this.value.revision++;
  }
  apply(op) {
    if (!op || !['read', 'pin', 'move', 'initialize'].includes(op.type)) throw new Error('无效的状态同步操作');
    const previous = this.value;
    let next = structuredClone(previous);
    const session = this.manager.sessions.get(op.name);
    if (op.type === 'initialize') {
      if (!validLayout(op.layout)) throw new Error('无效的会话排列');
      if (next.layout === null) {
        const exists = name => this.manager.sessions.has(name);
        next.layout = { order: op.layout.order.filter(exists), pinned: op.layout.pinned.filter(exists) };
      }
    } else {
      if (!validName(op.name) || !validTime(op.createdAt)) throw new Error('无效的会话身份');
      // Requests from sleeping devices must not affect a same-name replacement.
      if (!session || session.createdAt !== op.createdAt || session.archivedAt) return { shared: previous, accepted: false };
      const layout = next.layout || { order: this.manager.list().map(s => s.name), pinned: [] };
      const promote = () => { layout.order = [op.name, ...layout.order.filter(name => name !== op.name)]; next.layout = layout; };
      if (op.type === 'read') {
        if (typeof op.completed !== 'string' || !op.completed || op.completed.length > 1000) throw new Error('无效的已读记录');
        const activity = session.activity || {};
        if (session.status !== 'running' || activity.completed !== op.completed || activity.busy || activity.available === false ||
            activity.error || ['waiting', 'error', 'interrupted', 'unknown'].includes(activity.phase)) return { shared: previous, accepted: false };
        if (next.read[op.name]?.createdAt !== op.createdAt || next.read[op.name]?.completed !== op.completed) {
          next.read = { ...next.read, [op.name]: { createdAt: op.createdAt, completed: op.completed } };
          promote();
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
            layout.pinned.includes(op.name) !== layout.pinned.includes(op.target)) return { shared: previous, accepted: false };
        const order = [...new Set([...layout.order, ...this.manager.list().map(s => s.name)])].filter(name => name !== op.name);
        order.splice(order.indexOf(op.target) + Number(op.after), 0, op.name);
        next.layout = { ...layout, order };
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      next.revision++;
      this.value = next;
      try { this.manager.state?.save(this.manager.list(), next); }
      catch { this.value = previous; throw Object.assign(new Error('无法保存会话状态，请稍后重试'), { status: 503 }); }
      // Persist before broadcasting so a successful receipt survives restart.
      this.manager.emit('session:sync', { revision: next.revision });
    }
    return { shared: this.value, accepted: true };
  }
}
module.exports = SessionSync;
