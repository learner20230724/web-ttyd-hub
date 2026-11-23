const test = require('node:test');
const assert = require('node:assert/strict');
const { insertedImage, removeImage } = require('../server/services/composer-images');

test('identify the new image at the caret, excluding the previous turn and counting wide characters', () => {
  const lines = ['› [Image #1]', '  history', '', '› 中文[Image #1] [Image #2]', '', '  footer'];
  assert.deepEqual(insertedImage({ lines, x: 28, y: 3, active: true }), { slot: 2, count: 2 });
});

test('a stale count or a literal image label never produces a deletion keystroke', async () => {
  let x = 2, writes = 0;
  const io = {
    read: async () => ({ lines: ['› [Image #1]'], x, y: 0, active: true }),
    right: async () => { x++; },
    click: async () => { throw Error('Unexpected click'); },
    backspace: async () => { writes++; },
  };
  await assert.rejects(removeImage(io, { slot: 1, count: 2 }), { status: 409 });
  assert.equal(x, 2);
  await assert.rejects(removeImage(io, { slot: 1, count: 1 }), { status: 409 });
  assert.equal(writes, 0);
});
