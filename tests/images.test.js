const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionImages } = require('../server/services/session-images');
const { applyEvent } = require('../server/services/codex-activity');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
test('Images are scoped to a session generation; upload IDs cannot read arbitrary files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-images-unit-'));
  try {
    const store = new SessionImages(root), session = { name:'a', createdAt:'1', shell:'codex' };
    const image = await store.save(session, png);
    assert.deepEqual(await fs.readFile((await store.resolveUploads(session, [image.id]))[0]), png);
    await assert.rejects(store.resolveUploads({ ...session, createdAt:'2' }, [image.id]));
    await assert.rejects(store.resolveUploads({ ...session, name:'b' }, [image.id]));
    assert.throws(() => store.filename(session, '../../auth.json'));
    await assert.rejects(store.save(session, Buffer.from('<svg onload="alert(1)"/>')));
    await assert.rejects(store.resolveUploads({ ...session, shell:'bash' }, [image.id]));
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});
test('Rollout image inputs, viewed images and generated results survive projection without inline bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-images-events-'));
  try {
    const store = new SessionImages(root), session = { name:'a', createdAt:'1' }, state = {};
    const image = 'data:image/png;base64,' + png.toString('base64');
    const filename = path.join(root, 'view.png'); await fs.writeFile(filename, png);
    const events = [
      { type:'response_item', payload:{ type:'message', role:'user', content:[{ type:'input_text', text:'<image name=[Image #1] path="/private/screenshot.png">\n</image>\n[Image #1] 看图' }, { type:'input_image', image_url:image }] } },
      { type:'event_msg', payload:{ type:'view_image_tool_call', call_id:'view', path:filename } },
      { type:'event_msg', payload:{ type:'image_generation_end', call_id:'generate', status:'completed', result:png.toString('base64') } },
      { type:'response_item', payload:{ type:'message', role:'assistant', channel:'analysis', content:[{ type:'input_image', image_url:image }] } },
    ];
    for (const event of events) applyEvent(state, await store.project(session, event));
    assert.equal(state.messages.length, 3);
    assert.equal(state.messages[0].text, '看图');
    assert(state.messages.every(m => m.images.length === 1));
    assert(!JSON.stringify(state.messages).includes('base64'));
    const replay = {};
    for (const event of events) applyEvent(replay, await store.project(session, event));
    assert.deepEqual(replay.messages, state.messages);
    const remote = { type:'response_item', payload:{ type:'message', role:'user', content:[{ type:'input_image', image_url:'https://untrusted.invalid/image.png' }] } };
    await store.project(session, remote); assert.equal(remote.payload.hubImages, undefined);
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});
