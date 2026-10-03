const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { applyEvent } = require('./codex-activity');

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const homeDirectory = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const cleanTitle = value => String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 180);
function timestamp(value) {
  const n = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(n) && n >= 0 && n < 8.64e15 ? new Date(n).toISOString() : null;
}
async function readChunk(filename, limit, tail = false) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    const offset = tail ? Math.max(0, stat.size - limit) : 0;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset) text = text.slice(text.indexOf('\n') + 1);
    return { text, stat, truncated: stat.size > limit };
  } finally { await handle.close(); }
}

class CodexHistory {
  constructor(home = homeDirectory(), { sqlite = true, cacheMs = 10000 } = {}) {
    this.home = path.resolve(home); this.sqlite = sqlite; this.cacheMs = cacheMs;
    this.expires = 0; this.pending = null;
  }
  async index() {
    const names = new Map();
    try {
      const { text } = await readChunk(path.join(this.home, 'session_index.jsonl'), 8 * 1024 * 1024, true);
      for (const line of text.split('\n')) try {
        const row = JSON.parse(line);
        if (THREAD_ID.test(row.id)) names.set(row.id, row);
      } catch {}
    } catch {}
    return names;
  }
  async database() {
    if (!this.sqlite) return null;
    try {
      // Optional: older Node installations use the rollout fallback, no Python required.
      const { DatabaseSync } = require('node:sqlite');
      const files = (await fs.readdir(this.home)).filter(x => /^state_\d+\.sqlite$/.test(x))
        .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      for (const file of files) {
        let db;
        try {
          db = new DatabaseSync(path.join(this.home, file), { readOnly: true });
          const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(x => x.name));
          if (!['id', 'cwd', 'rollout_path'].every(x => columns.has(x))) continue;
          const optional = ['title', 'name', 'created_at', 'updated_at', 'source', 'archived'];
          const fields = ['id', 'cwd', 'rollout_path', ...optional.filter(x => columns.has(x))];
          return db.prepare(`SELECT ${fields.join(', ')} FROM threads`).all();
        } catch { /* Locked/incompatible metadata must not break the picker. */ }
        finally { db?.close(); }
      }
    } catch {}
    return null;
  }
  async rollouts() {
    const rows = [];
    const walk = async (dir, depth = 0) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const filename = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 4) await walk(filename, depth + 1);
        if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
        try {
          const { text, stat } = await readChunk(filename, 128 * 1024);
          const first = JSON.parse(text.split('\n')[0]);
          if (first.type !== 'session_meta') continue;
          const p = first.payload;
          const state = { messages: [], sequence: 0 };
          for (const line of text.split('\n').slice(1)) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'response_item' && event.payload?.role === 'user') applyEvent(state, event);
            } catch {}
            if (state.messages.length) break;
          }
          rows.push({ ...p, title: p.title || state.messages[0]?.text, rollout_path: filename, created_at: p.timestamp || first.timestamp, updated_at: stat.mtimeMs });
        } catch { /* Ignore partial/corrupt files, never return their raw contents. */ }
      }
    };
    await walk(path.join(this.home, 'sessions'));
    return rows;
  }
  async load() {
    if (this.rows && Date.now() < this.expires) return this.rows;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const names = await this.index();
      const rows = await this.database() ?? await this.rollouts();
      const unique = new Map();
      for (const row of rows) {
        if (!THREAD_ID.test(row.id) || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd) ||
            /[\x00-\x1f]/.test(row.cwd) || row.archived || JSON.stringify(row.source || '').includes('subagent') ||
            typeof row.rollout_path !== 'string') continue;
        const index = names.get(row.id);
        const updatedAt = timestamp(row.updated_at) || timestamp(index?.updated_at) || timestamp(row.created_at);
        unique.set(row.id.toLowerCase(), { id: row.id.toLowerCase(), cwd: path.resolve(row.cwd),
          title: cleanTitle(index?.thread_name || row.name || row.title) || `Codex ${row.id.slice(0, 8)}`,
          createdAt: timestamp(row.created_at), updatedAt, rolloutPath: row.rollout_path });
      }
      this.rows = [...unique.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id));
      this.expires = Date.now() + this.cacheMs;
      return this.rows;
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async thread(cwd, id) {
    if (typeof id !== 'string' || !THREAD_ID.test(id)) throw new Error('无效的 Codex 会话 ID');
    const row = (await this.load()).find(x => x.id === id.toLowerCase() && pathKey(x.cwd) === pathKey(cwd));
    if (!row) throw new Error('会话不存在或不属于所选项目，请刷新列表');
    // Neither database paths nor symlinks can grant API access outside sessions/.
    let file, root;
    try { [file, root] = await Promise.all([fs.realpath(row.rolloutPath), fs.realpath(path.join(this.home, 'sessions'))]); }
    catch { throw new Error('会话文件已移除或不可读取'); }
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.jsonl')) throw new Error('会话文件不在 Codex 历史目录中');
    const { text } = await readChunk(file, 128 * 1024);
    let meta;
    try { meta = JSON.parse(text.split('\n')[0]); } catch {}
    if (meta?.type !== 'session_meta' || meta.payload?.id?.toLowerCase() !== row.id ||
        typeof meta.payload.cwd !== 'string' || pathKey(meta.payload.cwd) !== pathKey(cwd)) throw new Error('会话元数据与所选项目不一致');
    return { ...row, rolloutPath: file };
  }
  async preview(cwd, id) {
    const row = await this.thread(cwd, id);
    const { text, truncated } = await readChunk(row.rolloutPath, 512 * 1024, true);
    const state = { messages: [], sequence: 0 };
    for (const line of text.split('\n')) try {
      const event = JSON.parse(line);
      if (event.type === 'response_item') applyEvent(state, event);
    } catch {}
    return { id: row.id, title: row.title, truncated: truncated || state.messages.length > 12,
      messages: state.messages.slice(-12).map(x => ({ role: x.role, text: x.text.slice(0, 4000) })) };
  }
}
let instance;
function history() {
  const home = path.resolve(homeDirectory());
  if (!instance || instance.home !== home) instance = new CodexHistory(home);
  return instance;
}
module.exports = { CodexHistory, history, THREAD_ID, pathKey };
