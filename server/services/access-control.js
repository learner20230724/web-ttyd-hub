const fs = require('node:fs');
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');

module.exports = function accessControl() {
  const config = process.env.HUB_AUTH_FILE ? JSON.parse(fs.readFileSync(process.env.HUB_AUTH_FILE, 'utf8')) : null;
  if (process.platform === 'win32' && !config) throw new Error('Windows Hub requires HUB_AUTH_FILE; refusing to expose an unauthenticated terminal');
  const base = (process.env.HUB_BASE_PATH || '').replace(/\/$/, '');
  const same = (a, b) => {
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  function validOrigin(req) {
    if (!config && !process.env.HUB_ALLOWED_ORIGINS) return true;
    if (!req.headers.origin) return true;
    const allowed = (process.env.HUB_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    return allowed.includes(req.headers.origin);
  }
  function valid(req) {
    if (!config) return true;
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const hash = createHash('sha256').update(config.salt + header.slice(6)).digest('hex');
      if (same(hash, config.hash)) return true;
    }
    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('hub_windows_auth='))?.slice(17);
    if (!token) return false;
    const [expires, signature] = token.split('.');
    if (!signature || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
    return same(createHmac('sha256', config.cookieKey).update(expires).digest('hex'), signature);
  }
  function normalize(req) {
    if (base && (req.url === base || req.url.startsWith(base + '/'))) req.url = req.url.slice(base.length) || '/';
  }
  function middleware(req, res, next) {
    if (!validOrigin(req)) return res.status(403).json({ error: 'Origin not allowed' });
    if (!valid(req)) {
      res.set('WWW-Authenticate', 'Basic realm="home-terminal", charset="UTF-8"');
      return res.status(401).send('Authentication required');
    }
    if (config && req.headers.authorization?.startsWith('Basic ')) {
      const expires = String(Date.now() + 12 * 3600 * 1000);
      const token = expires + '.' + createHmac('sha256', config.cookieKey).update(expires).digest('hex');
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.set('Set-Cookie', `hub_windows_auth=${token}; Path=${base || '/'}; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`);
    }
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store' });
    normalize(req); next();
  }
  function upgrade(req, socket) {
    if (!valid(req) || !validOrigin(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy(); return;
    }
    normalize(req);
  }
  return { middleware, upgrade };
};
