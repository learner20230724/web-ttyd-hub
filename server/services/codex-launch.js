const { THREAD_ID } = require('./codex-history');

function resumeId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !THREAD_ID.test(value)) throw new Error('无效的 Codex 会话 ID');
  return value.toLowerCase();
}
function codexArgs(id) {
  const value = resumeId(id);
  return value ? ['resume', value, '--yolo'] : ['--yolo'];
}
async function launchOptions(shell, cwd, id) {
  id = resumeId(id);
  if (id && shell !== 'codex') throw new Error('只有 Codex 终端可以恢复历史会话');
  if (id && !cwd) throw new Error('恢复会话前必须选择项目');
  const directory = cwd ? await require('./codex-projects').resolveProject(cwd) : undefined;
  if (id) await require('./codex-history').history().thread(directory, id);
  return { cwd: directory, resumeThreadId: id };
}
module.exports = { resumeId, codexArgs, launchOptions };
