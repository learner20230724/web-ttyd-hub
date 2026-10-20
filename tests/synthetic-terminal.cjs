// A synthetic protocol renderer for UI synchronization tests. No PTY is opened.
const { WebSocketServer } = require('ws');
const { SnapshotCache } = require('../server/services/terminal-stream');

module.exports = function syntheticTerminals(server, manager) {
  const wss = new WebSocketServer({ noServer: true }), cache = new SnapshotCache();
  const pending = [], snapshots = [];
  let held = false;
  server.on('upgrade', (req, socket, head) => {
    const match = /^\/ws\/terminal\/([a-zA-Z0-9_-]+)$/.exec(req.url || '');
    if (!match) return;
    wss.handleUpgrade(req, socket, head, ws => {
      let cols = 100, rows = 30, digest = null, optedIn = false;
      ws.on('message', bytes => {
        const message = JSON.parse(bytes);
        const session = manager.sessions.get(match[1]);
        if (!session || message.generation !== undefined && message.generation !== session.createdAt) { ws.close(1008); return; }
        if (message.type === 'resize') {
          cols = message.cols; rows = message.rows; optedIn = message.cache === 'splice-v1';
          if (message.digest) digest = message.digest;
        } else if (message.type !== 'checkpoint') return;
        const completed = session.activity?.completed || null;
        const snapshot = { type: 'snapshot', generation: session.createdAt, completed,
          meta: { pane_width: cols, pane_height: rows, history_size: 100, cursor_x: 0, cursor_y: rows - 1,
            alternate_on: 0, cursor_flag: 1, wrap_flag: 1, scroll_region_upper: 0, scroll_region_lower: rows - 1, pane_tabs: '' },
          screen: Array.from({ length: 100 }, (_, index) => `SYNTHETIC_${index}`).join('\n') + `\nFINAL_${completed || 'none'}`,
          normal: '', history: '', alternate: '', pending: '' };
        const response = cache.response(`${session.name}:${session.createdAt}`, snapshot, optedIn ? digest : null);
        digest = snapshot.digest; snapshots.push(snapshot);
        const send = () => { if (ws.readyState === 1) ws.send(JSON.stringify(response)); };
        if (held) pending.push(send); else send();
      });
    });
  });
  return { snapshots, pending,
    hold(value) { held = value; if (!value) pending.splice(0).forEach(send => send()); },
    close() { for (const socket of wss.clients) socket.terminate(); wss.close(); } };
};
