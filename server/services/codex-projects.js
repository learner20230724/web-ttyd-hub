const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Read desktop project metadata only; CLI history is supplied by codex-history.
function listProjects(filename = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json')) {
  let state;
  try { state = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { return { projects: [], error: '无法读取 Codex 项目列表，请先在本机 Codex 中打开项目后刷新。' }; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { projects: [] };
  const projects = [], seen = new Set();
  const selected = state['selected-project'];
  function add(root, name, active = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || /[\x00-\x1f]/.test(root)) return;
    try {
      if (!fs.statSync(root).isDirectory()) return;
      fs.accessSync(root, fs.constants.R_OK);
      const full = path.resolve(root), key = process.platform === 'win32' ? full.toLowerCase() : full;
      if (seen.has(key)) return;
      seen.add(key); projects.push({ name: typeof name === 'string' && name ? name : path.basename(full) || full, path: full, active });
    } catch { /* Removed/unmounted workspaces are not launch targets. */ }
  }
  const locals = state['local-projects'] || {};
  const order = [...new Set([...(Array.isArray(state['project-order']) ? state['project-order'] : []), ...Object.keys(locals)])];
  for (const id of order) {
    const project = locals[id];
    if (!project || !Array.isArray(project.rootPaths)) continue;
    for (const root of project.rootPaths) add(root, project.name, selected?.type === 'local' && selected.projectId === id);
  }
  for (const root of Array.isArray(state['electron-saved-workspace-roots']) ? state['electron-saved-workspace-roots'] : []) add(root);
  return { projects };
}
async function getProjects() {
  const { history, pathKey } = require('./codex-history');
  const rows = await history().load();
  const { projects } = listProjects();
  const seen = new Set(projects.map(x => pathKey(x.path)));
  const roots = [...rows.map(x => x.cwd), process.env.HUB_CWD || process.cwd()];
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || /[\x00-\x1f]/.test(root) || seen.has(pathKey(root))) continue;
    try {
      if (!fs.statSync(root).isDirectory()) continue;
      fs.accessSync(root, fs.constants.R_OK);
      projects.push({ name: path.basename(root) || root, path: path.resolve(root), active: false });
      seen.add(pathKey(root));
    } catch {}
  }
  const counts = new Map();
  for (const row of rows) counts.set(pathKey(row.cwd), (counts.get(pathKey(row.cwd)) || 0) + 1);
  return { projects: projects.map(x => ({ ...x, sessionCount: counts.get(pathKey(x.path)) || 0 })) };
}
async function resolveProject(cwd) {
  const { projects } = await getProjects();
  const project = typeof cwd === 'string' && path.isAbsolute(cwd) && projects.find(x => process.platform === 'win32' ? x.path.toLowerCase() === path.resolve(cwd).toLowerCase() : x.path === path.resolve(cwd));
  if (!project) throw new Error('请选择当前 Codex 项目列表中仍然存在的项目目录');
  return project.path;
}
module.exports = { listProjects, getProjects, resolveProject };
