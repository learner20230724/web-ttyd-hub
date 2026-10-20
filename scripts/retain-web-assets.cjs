const fs = require('node:fs');
const path = require('node:path');
const { isHashedAsset } = require('../server/services/frontend-static');

// Used before and after Vite empties its output directory. Copying preserves
// the original mtime, so retained generations expire instead of being renewed
// indefinitely on every deployment. Existing files always belong to the new
// build and must never be replaced, even when their names happen to match.
function retainWebAssets(sourceDir, targetDir, {
  now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000, maxBytes = 32 * 1024 * 1024,
} = {}) {
  const candidates = [];
  function walk(directory) {
    let directoryStat;
    try { directoryStat = fs.lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
    for (const item of fs.readdirSync(directory, { withFileTypes:true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) { walk(filename); continue; }
      if (!item.isFile()) continue;
      const relative = path.relative(sourceDir, filename).split(path.sep).join('/');
      if (!isHashedAsset(relative)) continue;
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < now - maxAgeMs) continue;
      candidates.push({ filename, relative, stat });
    }
  }
  walk(path.join(sourceDir, 'assets'));
  candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || left.relative.localeCompare(right.relative));
  let files = 0, bytes = 0;
  for (const item of candidates) {
    const destination = path.join(targetDir, ...item.relative.split('/'));
    if (bytes + item.stat.size > maxBytes) continue;
    // A dangling symlink is also an existing destination; do not follow it.
    try { fs.lstatSync(destination); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let directory = targetDir, safe = true;
    for (const part of item.relative.split('/').slice(0, -1)) {
      directory = path.join(directory, part);
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { safe = false; break; }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        fs.mkdirSync(directory, { recursive:true });
      }
    }
    if (!safe) continue;
    try { fs.copyFileSync(item.filename, destination, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    fs.utimesSync(destination, item.stat.atime, item.stat.mtime);
    files++; bytes += item.stat.size;
  }
  return { files, bytes };
}

module.exports = { retainWebAssets };
if (require.main === module) {
  const [sourceDir, targetDir, extra] = process.argv.slice(2);
  if (!sourceDir || !targetDir || extra) throw new Error('Usage: node retain-web-assets.cjs SOURCE_PUBLIC_DIR TARGET_PUBLIC_DIR');
  const result = retainWebAssets(sourceDir, targetDir);
  console.log(`Preserved ${result.files} hashed frontend assets (${result.bytes} bytes).`);
}
