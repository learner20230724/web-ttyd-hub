const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { retainWebAssets } = require('../scripts/retain-web-assets.cjs');

const day = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 20, 0, 0, 0);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-assets-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const source = path.join(directory, 'public'), target = path.join(directory, 'next');
  const write = (root, relative, body, age = 0) => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive:true }); fs.writeFileSync(filename, body);
    fs.utimesSync(filename, new Date(now - age), new Date(now - age));
    return filename;
  };
  return { directory, source, target, write };
}

test('a new build keeps its assets and retains a previous lazy chunk across a clean output replacement', t => {
  const { directory, source, target, write } = fixture(t);
  const stash = path.join(directory, 'retained');
  write(source, 'index.html', 'old HTML');
  write(source, 'assets/main-AbCdEF12.js', 'old main');
  write(source, 'assets/TerminalView-OlD12345.js', 'old lazy terminal');
  write(source, 'assets/TerminalView-OlD12345.css', 'old lazy styles');
  const kept = retainWebAssets(source, stash, { now });
  assert.equal(kept.files, 3);
  // Vite emptyOutDir removes all prior output. Only new build files exist
  // before the retained files are merged back by the deployment script.
  fs.rmSync(source, { recursive:true });
  write(source, 'index.html', 'new HTML');
  write(source, 'assets/main-AbCdEF12.js', 'new main wins');
  write(source, 'assets/TerminalView-NeW12345.js', 'new lazy terminal');
  const merged = retainWebAssets(stash, source, { now });
  assert.equal(merged.files, 2);
  assert.equal(fs.readFileSync(path.join(source, 'assets/main-AbCdEF12.js'), 'utf8'), 'new main wins');
  assert.equal(fs.readFileSync(path.join(source, 'assets/TerminalView-NeW12345.js'), 'utf8'), 'new lazy terminal');
  assert.equal(fs.readFileSync(path.join(source, 'assets/TerminalView-OlD12345.js'), 'utf8'), 'old lazy terminal');
  assert.equal(fs.readFileSync(path.join(source, 'assets/TerminalView-OlD12345.css'), 'utf8'), 'old lazy styles');
  assert.equal(fs.readFileSync(path.join(source, 'index.html'), 'utf8'), 'new HTML');
  assert.equal(fs.existsSync(target), false);
});

test('only recent hashed assets cross builds, and their age survives repeated retention', t => {
  const { source, target, write } = fixture(t);
  const valid = write(source, 'assets/TerminalView-AbCdEF12.js', 'recent lazy code', 2 * day);
  write(source, 'assets/nested/image-AbCdEF12.svg', '<svg/>', day);
  write(source, 'assets/expired-AbCdEF12.js', 'expired code', 8 * day);
  for (const relative of ['index.html', 'assets/runtime.js', 'assets/index-short.js', 'assets/page-AbCdEF12.html',
    'assets/private.env', 'outside/other-AbCdEF12.js']) write(source, relative, 'must not survive');
  const result = retainWebAssets(source, target, { now });
  assert.equal(result.files, 2);
  assert.equal(fs.readFileSync(path.join(target, 'assets/TerminalView-AbCdEF12.js'), 'utf8'), 'recent lazy code');
  assert(Math.abs(fs.statSync(path.join(target, 'assets/TerminalView-AbCdEF12.js')).mtimeMs - fs.statSync(valid).mtimeMs) < 5);
  for (const relative of ['index.html', 'assets/runtime.js', 'assets/index-short.js', 'assets/page-AbCdEF12.html',
    'assets/private.env', 'outside/other-AbCdEF12.js', 'assets/expired-AbCdEF12.js']) assert.equal(fs.existsSync(path.join(target, relative)), false);
  const later = path.join(target, 'later-generation');
  assert.deepEqual(retainWebAssets(target, later, { now:now + 8 * day }), { files:0, bytes:0 }, 'Copies must not renew the old chunk lifetime');
});

test('the retained byte budget prefers newer old files and never removes or counts the current build', t => {
  const { source, target, write } = fixture(t);
  write(source, 'assets/newest-AbCdEF12.js', '12345678');
  write(source, 'assets/middle-AbCdEF12.js', '12345678', day);
  write(source, 'assets/oldest-AbCdEF12.js', '12', 2 * day);
  write(source, 'assets/current-AbCdEF12.js', 'old current');
  write(target, 'assets/current-AbCdEF12.js', 'new current '.repeat(100));
  write(target, 'assets/newbuild-AbCdEF12.js', 'always keep current build '.repeat(100));
  const result = retainWebAssets(source, target, { now, maxBytes:10 });
  assert.deepEqual(result, { files:2, bytes:10 });
  assert.equal(fs.readFileSync(path.join(target, 'assets/newest-AbCdEF12.js'), 'utf8'), '12345678');
  assert.equal(fs.existsSync(path.join(target, 'assets/middle-AbCdEF12.js')), false);
  assert.equal(fs.readFileSync(path.join(target, 'assets/oldest-AbCdEF12.js'), 'utf8'), '12');
  assert.equal(fs.readFileSync(path.join(target, 'assets/current-AbCdEF12.js'), 'utf8'), 'new current '.repeat(100));
  assert.equal(fs.readFileSync(path.join(target, 'assets/newbuild-AbCdEF12.js'), 'utf8'), 'always keep current build '.repeat(100));
});

test('a first build without existing output has nothing to retain', t => {
  const { source, target } = fixture(t);
  assert.deepEqual(retainWebAssets(source, target, { now }), { files:0, bytes:0 });
  assert.equal(fs.existsSync(target), false);
});

test('asset retention does not follow symbolic files or directories', { skip:process.platform === 'win32' }, t => {
  const { directory, source, target, write } = fixture(t);
  write(source, 'assets/valid-AbCdEF12.js', 'keep');
  const privateDir = path.join(directory, 'private');
  const privateFile = write(privateDir, 'secret-AbCdEF12.js', 'private fixture');
  fs.symlinkSync(privateFile, path.join(source, 'assets/link-AbCdEF12.js'));
  fs.symlinkSync(privateDir, path.join(source, 'assets/linked-directory'));
  fs.mkdirSync(path.join(target, 'assets'), { recursive:true });
  fs.symlinkSync(path.join(directory, 'must-not-be-created'), path.join(target, 'assets/valid-AbCdEF12.js'));
  assert.deepEqual(retainWebAssets(source, target, { now }), { files:0, bytes:0 });
  assert.equal(fs.existsSync(path.join(directory, 'must-not-be-created')), false);
  assert.equal(fs.existsSync(path.join(target, 'assets/link-AbCdEF12.js')), false);
  assert.equal(fs.existsSync(path.join(target, 'assets/linked-directory/secret-AbCdEF12.js')), false);
});
