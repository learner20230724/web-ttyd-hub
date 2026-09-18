const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class SessionState {
  constructor(filename) { this.filename = filename; }
  read() {
    if (!fs.existsSync(this.filename)) return [];
    const data = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('Invalid session state; restore sessions.json.bak before starting');
    const ids = new Set(), labels = new Set();
    for (const s of data.sessions) {
      if (!s || typeof s.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(s.name) || ids.has(s.name) ||
          typeof s.displayName !== 'string' || !s.displayName.trim() || [...s.displayName].length > 80 || /[\p{Cc}\p{Cf}]/u.test(s.displayName) || labels.has(s.displayName) ||
          !['running', 'stopped'].includes(s.status) || ![null, 'bash', 'zsh', 'fish', 'sh'].includes(s.shell) ||
          typeof s.createdAt !== 'string' || !Number.isFinite(Date.parse(s.createdAt))) throw new Error('Invalid saved session record; refusing to overwrite state');
      if ((s.archivedAt || s.expiresAt) && (!Number.isFinite(Date.parse(s.archivedAt)) || !Number.isFinite(Date.parse(s.expiresAt)) || Date.parse(s.expiresAt) - Date.parse(s.archivedAt) !== 1800000)) throw new Error('Invalid archive deadline');
      ids.add(s.name); labels.add(s.displayName);
    }
    return data.sessions;
  }
  save(sessions) {
    const records = sessions.map(s => ({ name: s.name, displayName: s.displayName || s.name, shell: s.shell || null,
      status: s.status, createdAt: s.createdAt, ...(s.archivedAt ? { archivedAt: s.archivedAt, expiresAt: s.expiresAt } : {}), ...(s.codexThreadId ? { codexThreadId: s.codexThreadId } : {}) }));
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temp = `${this.filename}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, sessions: records }, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      if (fs.existsSync(this.filename)) {
        fs.copyFileSync(this.filename, `${this.filename}.bak`);
        fs.chmodSync(`${this.filename}.bak`, 0o600);
      }
      fs.renameSync(temp, this.filename);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
}
module.exports = SessionState;
