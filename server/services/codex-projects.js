const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Read only project metadata, never auth.json, conversations or desktop settings.
function listProjects(filename = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json')) {
  let state;
  try { state = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { return { projects: [], error: '无法读取 Codex 项目列表，请先在本机 Codex 中打开项目后刷新。' }; }
  const projects = [], seen = new Set();
  const selected = state['selected-project'];
  function add(root, name, active = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return;
    try {
      if (!fs.statSync(root).isDirectory()) return;
      fs.accessSync(root, fs.constants.R_OK);
      const full = path.resolve(root), key = process.platform === 'win32' ? full.toLowerCase() : full;
      if (seen.has(key)) return;
      seen.add(key); projects.push({ name: name || path.basename(full) || full, path: full, active });
    } catch { /* Removed/unmounted workspaces are not launch targets. */ }
  }
  const locals = state['local-projects'] || {};
  const order = [...new Set([...(state['project-order'] || []), ...Object.keys(locals)])];
  for (const id of order) {
    const project = locals[id];
    if (!project || !Array.isArray(project.rootPaths)) continue;
    for (const root of project.rootPaths) add(root, project.name, selected?.type === 'local' && selected.projectId === id);
  }
  for (const root of state['electron-saved-workspace-roots'] || []) add(root);
  return { projects };
}
function resolveProject(cwd) {
  const { projects } = listProjects();
  const project = typeof cwd === 'string' && projects.find(x => process.platform === 'win32' ? x.path.toLowerCase() === path.resolve(cwd).toLowerCase() : x.path === path.resolve(cwd));
  if (!project) throw new Error('请选择当前 Codex 项目列表中仍然存在的项目目录');
  return project.path;
}
module.exports = { listProjects, resolveProject };
