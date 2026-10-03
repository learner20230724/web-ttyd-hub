const express = require('express');
const contentResponse = require('../services/content-response');
const { getProjects, resolveProject } = require('../services/codex-projects');
const { history, pathKey } = require('../services/codex-history');

module.exports = function (sessionManager) {
  const router = express.Router();
  const resumeLocks = new Map();
  router.get('/shells', (req, res) => {
    res.json({ shells: sessionManager.getShells(), platform: process.platform });
  });

  router.get('/projects', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await getProjects()); }
    catch { res.status(500).json({ error: '无法读取项目列表，请稍后刷新' }); }
  });

  router.get('/codex-history', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const cwd = await resolveProject(req.query.cwd);
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200).toLowerCase() : '';
      const offset = Number(req.query.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效的分页位置');
      const rows = (await history().load()).filter(x => pathKey(x.cwd) === pathKey(cwd) && (!q || `${x.title} ${x.id}`.toLowerCase().includes(q)));
      const sessions = rows.slice(offset, offset + 50).map(({ rolloutPath, ...row }) => {
        const linked = sessionManager.list().find(x => x.shell === 'codex' && x.cwd && pathKey(x.cwd) === pathKey(cwd) &&
          (x.codexThreadId === row.id || x.resumeThreadId === row.id) && (!x.expiresAt || Date.parse(x.expiresAt) > Date.now()));
        return { ...row, hubSession: linked ? { name: linked.name, status: linked.status, archived: !!linked.archivedAt } : null };
      });
      res.json({ sessions, total: rows.length, nextOffset: offset + sessions.length < rows.length ? offset + sessions.length : null });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.get('/codex-history/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await history().preview(await resolveProject(req.query.cwd), req.params.id)); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.get('/', (req, res) => {
    res.json({ sessions: sessionManager.list() });
  });

  router.post('/', async (req, res) => {
    try {
      const { name, shell, cwd, resumeThreadId } = req.body;
      if (resumeThreadId) {
        const options = await require('../services/codex-launch').launchOptions(shell, cwd, resumeThreadId);
        const key = `${pathKey(options.cwd)}:${options.resumeThreadId}`;
        if (!resumeLocks.has(key)) {
          const task = Promise.resolve().then(async () => {
            const existing = sessionManager.list().find(x => x.shell === 'codex' && x.cwd && pathKey(x.cwd) === pathKey(options.cwd) &&
              (x.codexThreadId === options.resumeThreadId || x.resumeThreadId === options.resumeThreadId) && (!x.expiresAt || Date.parse(x.expiresAt) > Date.now()));
            if (existing) {
              if (existing.archivedAt) sessionManager.restoreArchived(existing.name);
              if (existing.status !== 'running') await sessionManager.restart(existing.name);
              return sessionManager.serialize(sessionManager.getSession(existing.name));
            }
            return sessionManager.create(name, shell, options.cwd, options.resumeThreadId);
          });
          resumeLocks.set(key, task);
        }
        const task = resumeLocks.get(key);
        try { return res.json(await task); }
        finally { if (resumeLocks.get(key) === task) resumeLocks.delete(key); }
      }
      const session = await sessionManager.create(name, shell, cwd);
      res.status(201).json(session);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/:name/history', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      contentResponse(req, res, await sessionManager.history(req.params.name));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/:name/mobile', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { contentResponse(req, res, await sessionManager.mobile(req.params.name, req.query.view === 'full')); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  router.post('/:name/input', async (req, res) => {
    try { res.json(await sessionManager.input(req.params.name, req.body)); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.patch('/:name', (req, res) => {
    try {
      res.json(sessionManager.rename(req.params.name, req.body.name));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:name/stop', (req, res) => {
    try {
      const session = sessionManager.stop(req.params.name);
      res.json(session);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:name/restart', async (req, res) => {
    try {
      const session = await sessionManager.restart(req.params.name);
      res.json(session);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:name/restore', (req, res) => {
    try { res.json(sessionManager.restoreArchived(req.params.name)); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  router.delete('/:name/permanent', async (req, res) => {
    try {
      if (!sessionManager.getSession(req.params.name).archivedAt) throw new Error('请先将会话移入归档');
      res.json(await sessionManager.remove(req.params.name));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.delete('/:name', async (req, res) => {
    try {
      const result = sessionManager.archive(req.params.name);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
