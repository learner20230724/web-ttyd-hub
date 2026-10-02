const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const linuxIntegration = new Set(['codex-session.test.js', 'session-names.test.js', 'session-state.test.js']);
const files = fs.readdirSync(path.join(__dirname, '../tests')).filter(x => x.endsWith('.test.js') && (process.platform !== 'win32' || !linuxIntegration.has(x))).map(x => 'tests/' + x);
if (process.platform === 'win32') console.log('Windows: Linux ttyd/tmux integration suites are excluded; verify native deployments separately.');
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
process.exit(result.status ?? 1);
