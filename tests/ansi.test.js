const { test } = require('node:test');
const assert = require('node:assert/strict');
const parser = import('../frontend/src/utils/ansi.mjs');

test('ANSI colors, RGB, indexed colors and resets retain the original text', async () => {
  const { ansiToRuns } = await parser;
  const runs = ansiToRuns('\x1b[31m红\x1b[1m重点\x1b[0m普通\x1b[38;5;196m索引\x1b[38;2;12;34;56m真彩\x1b[39m默认');
  assert.equal(runs.map(r => r.text).join(''), '红重点普通索引真彩默认');
  assert.equal(runs[0].style.color, '#cc0000');
  assert.equal(runs[1].style.color, '#ef2929');
  assert.equal(runs[1].style.fontWeight, '700');
  assert.equal(runs[2].style.color, '#ffffff');
  assert.equal(runs[2].style.fontWeight, undefined);
  assert.equal(runs[3].style.color, 'rgb(255, 0, 0)');
  assert.equal(runs[4].style.color, 'rgb(12, 34, 56)');
  assert.equal(runs[5].style.color, '#ffffff');
});

test('backgrounds, decorations, dim and inverse survive until reset', async () => {
  const { ansiToRuns } = await parser;
  const runs = ansiToRuns('\x1b[32;44;2;3;4;9mA\nB\x1b[7mC\x1b[22;23;24;27;29;39;49mD');
  assert.equal(runs[0].text, 'A\nB');
  assert.deepEqual(runs[0].style, { color: '#4e9a06', backgroundColor: '#3465a4', opacity: '0.5', fontStyle: 'italic', textDecorationLine: 'underline line-through' });
  assert.equal(runs[1].style.color, '#3465a4');
  assert.equal(runs[1].style.backgroundColor, '#4e9a06');
  assert.deepEqual(runs[2].style, { color: '#ffffff', backgroundColor: '#000000' });
});

test('colon RGB, grayscale, malformed parameters and plain-text fallback', async () => {
  const { ansiToRuns } = await parser;
  assert.equal(ansiToRuns('\x1b[38:2::10:20:30mA')[0].style.color, 'rgb(10, 20, 30)');
  assert.equal(ansiToRuns('\x1b[48:5:255mA')[0].style.backgroundColor, 'rgb(238, 238, 238)');
  assert.equal(ansiToRuns('\x1b[38;2;999;0;0mA')[0].style.color, '#ffffff');
  assert.equal(ansiToRuns('中文\n  缩进\t文本')[0].text, '中文\n  缩进\t文本');
});

test('HTML stays inert text and non-style terminal controls are discarded', async () => {
  const { ansiToRuns } = await parser;
  const raw = '<img src=x onerror=alert(1)>&';
  const runs = ansiToRuns('\x1b]8;;javascript:alert(1)\x07' + raw + '\x1b]8;;\x07\x1b[2J');
  assert.equal(runs.map(r => r.text).join(''), raw);
  assert.deepEqual(runs[0].style, { color: '#ffffff', backgroundColor: '#000000' });
});
