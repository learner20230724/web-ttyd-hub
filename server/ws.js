const { WebSocketServer } = require('ws');

function setupWebSocket(server, sessionManager) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (socket.destroyed) return;
    const url = req.url || '';
    const pathname = url.split('?')[0];
    if (pathname !== '/ws') return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  const heartbeat = setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, 25000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));

  function broadcast(event, data) {
    const message = JSON.stringify({ event, data });
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }

  const events = [
    'session:created',
    'session:archived',
    'session:restored',
    'session:activity',
    'session:renamed',
    'session:stopped',
    'session:deleted',
    'session:exited'
  ];

  for (const event of events) {
    sessionManager.on(event, (data) => broadcast(event, data));
  }

  return wss;
}

module.exports = setupWebSocket;
