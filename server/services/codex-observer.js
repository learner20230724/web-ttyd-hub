// Read-only adapters for standalone Codex and the shared app-server daemon.
// A daemon owns many threads: never use its first/newest rollout as a pane's identity.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const rolloutPattern = /[/\\]sessions[/\\].*[/\\]rollout-[^/\\]+\.jsonl$/;

async function openedFiles(pid) {
  const links = await Promise.allSettled((await fs.readdir(`/proc/${pid}/fd`)).map(fd => fs.readlink(`/proc/${pid}/fd/${fd}`)));
  return [...new Set(links.filter(x => x.status === 'fulfilled').map(x => x.value))];
}
async function findCodex(pid, depth = 0) {
  if (depth > 8) return null;
  try {
    const comm = (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
    if (comm === 'codex') {
      const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      if (args.includes('app-server') || args.includes('exec')) return null;
      return { pid, files: await openedFiles(pid) };
    }
    // Rust/Node can spawn a child from a worker thread, not the thread-group leader.
    const tasks = await fs.readdir(`/proc/${pid}/task`);
    const children = await Promise.allSettled(tasks.map(tid => fs.readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')));
    const ids = new Set(children.flatMap(r => r.status === 'fulfilled' ? r.value.trim().split(/\s+/).filter(Boolean) : []));
    const clients = [];
    for (const child of ids) { const found = await findCodex(child, depth + 1); if (found) clients.push(found); }
    return clients.length === 1 ? clients[0] : null;
  } catch { /* Process exited or is not readable. */ }
  return null;
}

function daemonConnections(output) {
  const sockets = new Map(), peers = new Map();
  for (const line of output.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'u_str' || f[1] !== 'ESTAB') continue;
    sockets.set(f[5], { address: f[4], peer: f[7], pids: [...line.matchAll(/pid=(\d+),/g)].map(m => m[1]) });
  }
  for (const socket of sockets.values()) {
    const peer = sockets.get(socket.peer);
    if (!peer?.address.includes('/codex-daemon-')) continue;
    for (const pid of socket.pids) if (peer.pids.length === 1) peers.set(pid, { pid: peer.pids[0], socket: peer.address });
  }
  return peers;
}
function daemonPeers(output) { return new Map([...daemonConnections(output)].map(([pid, peer]) => [pid, peer.pid])); }

async function metadata(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const first = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]);
    return first.type === 'session_meta' ? first.payload : null;
  } finally { await file.close(); }
}
function plainTitle(title) { return String(title || '').replace(/^(?:[\u2800-\u28ff✓✔●]+\s+)+/u, '').trim(); }
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function titlePart(value, limit) {
  const chars = [...graphemes.segment(value)].map(part => part.segment);
  return chars.length <= limit ? value : chars.slice(0, limit - 3).join('') + '...';
}
async function projectName(cwd) {
  // Codex's default project label is the repository root, even when the CLI
  // starts in a subdirectory. Worktrees use a .git file instead of a directory.
  let dir = cwd, configuredRoot;
  while (dir && path.isAbsolute(dir)) {
    if (await fs.stat(path.join(dir, '.git')).then(() => true, () => false)) return path.basename(dir);
    if (!configuredRoot && await fs.stat(path.join(dir, '.codex', 'config.toml')).then(s => s.isFile(), () => false)) configuredRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.basename(configuredRoot || cwd);
}
function selectRollout(candidates, title, shared) {
  const roots = candidates.filter(c => c.meta?.id && !JSON.stringify(c.meta.source || '').includes('subagent'));
  if (!shared && roots.length === 1) return roots[0];
  const label = plainTitle(title);
  // Codex 0.162 blinks between these two prefixes while requesting input.
  // Keep the literal title too: a real name can contain the same words, and
  // ambiguity across either interpretation must still leave the pane unbound.
  const labels = new Set([label, plainTitle(label.replace(/^\[ [!.] \] Action Required \| /, ''))]);
  // Match the full title, including project, and require uniqueness. In particular,
  // a saved Hub thread id is NOT proof after /new, /resume or a process restart.
  const matches = roots.filter(c => {
    if (!c.name) return false;
    const name = c.name.trim(), project = c.projectName ?? path.basename(c.meta.cwd || '');
    // Codex 0.162 renders at most 48/24 graphemes. Compare the exact rendered
    // title, and still reject collisions introduced by the truncation itself.
    return labels.has(`${name} | ${project}`) || labels.has(`${titlePart(name, 48)} | ${titlePart(project, 24)}`);
  });
  return matches.length === 1 ? matches[0] : null;
}
async function resolveRollout(files, title, shared = false) {
  const paths = files.filter(file => rolloutPattern.test(file));
  const candidates = (await Promise.allSettled(paths.map(async filename => ({ path: filename, meta: await metadata(filename) }))))
    .filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!shared && candidates.length === 1) return selectRollout(candidates, title, false)?.path || null;
  // Names are metadata, not message text. Read only rows for files verified open
  // in this daemon; never search unrelated conversations by cwd or modification time.
  try {
    const { DatabaseSync } = require('node:sqlite');
    for (const filename of files.filter(file => /[/\\]state_\d+\.sqlite$/.test(file))) {
      let db;
      try {
        db = new DatabaseSync(filename, { readOnly: true });
        const hasCwd = db.prepare('PRAGMA table_info(threads)').all().some(column => column.name === 'cwd');
        const query = db.prepare(`SELECT name${hasCwd ? ', cwd' : ''} FROM threads WHERE id = ?`);
        for (const candidate of candidates) {
          const row = query.get(candidate.meta?.id);
          candidate.name = row?.name;
          candidate.cwd = row?.cwd || candidate.meta?.cwd || '';
        }
      } finally { db?.close(); }
    }
  } catch { /* Unavailable metadata leaves an ambiguous daemon unbound. */ }
  const projects = new Map();
  for (const candidate of candidates) if (candidate.name) {
    const cwd = candidate.cwd || candidate.meta?.cwd || '';
    if (!projects.has(cwd)) projects.set(cwd, projectName(cwd));
    candidate.projectName = await projects.get(cwd);
  }
  return selectRollout(candidates, title, shared)?.path || null;
}

class LinuxCodexObserver {
  async begin() {
    this.peers = null; this.daemons = new Map();
  }
  async observe(pid, title) {
    const client = await findCodex(pid);
    if (!client) return { detected: false, path: null };
    const direct = await resolveRollout(client.files, title);
    if (direct) return { detected: true, path: direct };
    if (!this.peers) {
      this.peers = run('ss', ['-xnpH'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 })
        .then(({ stdout }) => daemonConnections(stdout)).catch(() => new Map());
    }
    const connection = (await this.peers).get(client.pid);
    const daemonPid = connection?.pid;
    if (!daemonPid) return { detected: true, path: null };
    if (!this.daemons.has(daemonPid)) this.daemons.set(daemonPid, (async () => {
      const args = (await fs.readFile(`/proc/${daemonPid}/cmdline`, 'utf8')).split('\0');
      return args.includes('app-server') && args.includes('--managed-daemon') ? openedFiles(daemonPid) : [];
    })().catch(() => []));
    const rollout = await resolveRollout(await this.daemons.get(daemonPid), title, true);
    return { detected: true, path: rollout, socket: rollout ? connection.socket : null };
  }
}

// Only the live composer/footer is considered, never arbitrary transcript text.
function terminalStatus(text) {
  const lines = String(text || '').trimEnd().split('\n');
  const tail = lines.slice(-18).join('\n');
  if (/^\s*(?:Would you like to (?:run|make|allow)|Do you (?:want|approve)|Allow .+\?)\s*/im.test(tail) &&
      /^\s*[›❯>]\s*\d+[.)]\s/m.test(tail) && /(?:esc to cancel|enter to (?:confirm|select))/i.test(tail)) return 'waiting';
  if (/^\s*[•◦\u2800-\u28ff]\s*Reconnecting[^\n]*(?:\d+\/\d+|esc to interrupt)/im.test(tail)) return 'retrying';
  if (/^\s*[•◦\u2800-\u28ff]\s*[^\n]{0,160}\(\d[^\n]*esc to interrupt\)/im.test(tail)) return 'working';
  return null;
}
module.exports = { LinuxCodexObserver, daemonConnections, daemonPeers, selectRollout, resolveRollout, terminalStatus };
