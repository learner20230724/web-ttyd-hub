// Only a commit identifier is exposed; never include environment/configuration.
try { module.exports = require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: require('node:path').join(__dirname, '../..'), encoding: 'utf8', timeout: 1000 }).trim(); }
catch { module.exports = 'unknown'; }
