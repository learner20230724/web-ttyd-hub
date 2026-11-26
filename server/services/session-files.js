const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { currentThread } = require('./session-identity');

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 8;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const marker = '附件文件（本机路径）';
const root = () => path.resolve(process.env.HUB_FILE_DIR || path.join(path.dirname(process.env.HUB_STATE_FILE || path.join(process.env.TMUX_TMPDIR || path.join(__dirname, '../../data'), 'sessions.json')), 'files'));

function directory(session) {
  const scope = JSON.stringify([session.name, session.createdAt || '', currentThread(session)]);
  return path.join(root(), createHash('sha256').update(scope).digest('hex'));
}

function checkSession(session) {
  if (session.status !== 'running' || !(session.shell === 'codex' || session.activity?.detected)) {
    throw new Error('请在运行中的 Codex 会话中添加文件');
  }
}

function checkName(name) {
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 240 ||
      /[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('文件名无法保存，请缩短名称或移除特殊字符');
  }
}

function checkSize(size) {
  if (size > MAX_BYTES) throw Object.assign(new Error('单个文件最大 50 MB'), { status: 413 });
}

async function save(session, name, source, stillCurrent) {
  checkSession(session);
  checkName(name);
  const parent = directory(session), id = randomUUID();
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await fs.mkdtemp(path.join(parent, '.upload-'));
  try {
    const file = await fs.open(path.join(temporary, name), 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of source) {
        size += chunk.length;
        checkSize(size);
        await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    stillCurrent();
    await fs.rename(temporary, path.join(parent, id));
    return { id, name, size };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function resolve(session, ids) {
  checkSession(session);
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_FILES || ids.some(id => typeof id !== 'string' || !uuid.test(id))) {
    throw new Error('请选择 1 至 8 个已上传的文件');
  }
  const parent = directory(session);
  return Promise.all(ids.map(async id => {
    const dir = path.join(parent, id);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (entries.length !== 1 || !entries[0].isFile()) throw new Error('附件已不可用，请重新选择');
    return path.join(dir, entries[0].name);
  }));
}

function prompt(text, files) {
  if (text != null && typeof text !== 'string') throw new Error('消息文字无效');
  return [marker, ...files, ...(text ? ['', text] : [])].join('\n');
}

// Only project the generated path block. Preserve ordinary text and never read
// files named in conversation history.
function displayPrompt(text) {
  if (!text.startsWith(marker + '\n')) return text;
  const lines = text.split('\n');
  const names = [];
  let i = 1;
  for (; i < lines.length && lines[i]; i++) {
    const parts = path.relative(root(), lines[i]).split(path.sep);
    if (parts.length !== 3 || !/^[a-f0-9]{64}$/.test(parts[0]) || !uuid.test(parts[1])) return text;
    names.push(parts[2]);
  }
  return names.length ? [lines.slice(i + 1).join('\n'), ...names.map(name => '附件：' + name)].filter(Boolean).join('\n') : text;
}

module.exports = { save, resolve, checkSize, prompt, displayPrompt };
