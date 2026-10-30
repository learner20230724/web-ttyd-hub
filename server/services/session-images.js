const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');

const LIMIT = 20 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
function format(bytes) {
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.length > 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片');
}
class SessionImages {
  constructor(root = process.env.HUB_IMAGE_DIR || path.join(path.dirname(process.env.HUB_STATE_FILE || path.join(process.env.TMUX_TMPDIR || path.join(__dirname, '../../data'), 'sessions.json')), 'images')) {
    this.root = root;
  }
  directory(session) { return path.join(this.root, hash(JSON.stringify([session.name, session.createdAt || '']))); }
  filename(session, id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}\.(png|jpeg|webp|gif)$/.test(id)) throw new Error('图片不存在');
    return path.join(this.directory(session), id);
  }
  async save(session, bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMIT) throw new Error('每张图片最大 20 MB');
    const extension = format(bytes), id = `${hash(bytes)}.${extension}`;
    const filename = this.filename(session, id);
    await fs.mkdir(this.directory(session), { recursive: true, mode: 0o700 });
    try { await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return { id };
  }
  async local(session, filename) {
    if (typeof filename !== 'string') return null;
    if (filename.startsWith('file://')) filename = fileURLToPath(filename);
    if (!path.isAbsolute(filename)) return null;
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > LIMIT) return null;
    return this.save(session, await fs.readFile(filename));
  }
  async inline(session, value) {
    if (typeof value !== 'string' || value.length > LIMIT * 1.4) return null;
    const match = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
    return match ? this.save(session, Buffer.from(match[1], 'base64')) : null;
  }
  // Only explicit image records become browser assets. Never expose arbitrary
  // filesystem paths or fetch remote URLs embedded in model/tool text.
  async project(session, event) {
    const p = event.payload || {}, images = [];
    const add = async read => { try { const image = await read(); if (image && !images.some(x => x.id === image.id)) images.push(image); } catch {} };
    if (event.type === 'event_msg') {
      if (p.type === 'view_image_tool_call') await add(() => this.local(session, p.path));
      if (p.type === 'image_generation_end' && p.status === 'completed') {
        await add(() => this.local(session, p.saved_path));
        if (!images.length && p.result) await add(() => this.inline(session, `data:image/png;base64,${p.result}`));
      }
    }
    if (event.type === 'response_item') {
      let blocks = [];
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role) && !['analysis', 'summary'].includes(p.channel)) blocks = p.content || [];
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type) && Array.isArray(p.output)) blocks = p.output;
      for (const block of blocks) {
        if (block.type === 'input_image') await add(() => this.inline(session, block.image_url));
        if (block.type === 'image' && block.data && block.mimeType) await add(() => this.inline(session, `data:${block.mimeType};base64,${block.data}`));
      }
    }
    if (images.length) p.hubImages = images;
    return event;
  }
  async resolveUploads(session, ids) {
    if (ids == null) return [];
    if (!Array.isArray(ids) || ids.length > 8) throw new Error('一次最多发送 8 张图片');
    if (ids.length && session.shell !== 'codex' && !session.activity?.detected) throw new Error('请在 Codex 会话中发送图片');
    return Promise.all(ids.map(async id => { const filename = this.filename(session, id); try { await fs.access(filename); } catch { throw new Error('图片已移除，请重新添加'); } return filename; }));
  }
}
module.exports = { SessionImages, LIMIT, format };
