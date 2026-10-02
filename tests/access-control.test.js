const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

// Synthetic credentials only; no local deployment files are read.
const basic = Buffer.from('test-user:test-password').toString('base64');
const config = { salt: 'test-salt', cookieKey: 'test-cookie-key',
  hash: createHash('sha256').update('test-salt' + basic).digest('hex') };
function access(env = {}, configured = true) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/services/access-control.js'), 'utf8'), {
    module, Buffer, process: { platform: 'win32', env: {
      ...(configured ? { HUB_AUTH_FILE: 'synthetic.json' } : {}), ...env,
    } },
    require: name => name === 'node:fs' ? { readFileSync: () => JSON.stringify(config) } : require(name),
  });
  return module.exports();
}
function response() {
  return { headers: {}, statusCode: 200,
    set(key, value) { if (typeof key === 'string') this.headers[key] = value; else Object.assign(this.headers, key); return this; },
    status(code) { this.statusCode = code; return this; }, send() { return this; }, json() { return this; } };
}

test('Windows access control refuses to start without an auth file', () => {
  assert.throws(() => access({}, false), /requires HUB_AUTH_FILE/);
});

test('HTTP and WebSocket access reject unauthenticated clients', () => {
  const control = access(), res = response();
  control.middleware({ headers: {}, url: '/api/sessions' }, res, () => assert.fail('accepted'));
  assert.equal(res.statusCode, 401);
  const socket = { write(value) { this.reply = value; }, destroy() { this.destroyed = true; } };
  control.upgrade({ headers: {}, url: '/ws' }, socket);
  assert.match(socket.reply, /401/); assert.equal(socket.destroyed, true);
});

test('Authenticated requests normalize prefixes and issue HTTPS-only cookies', () => {
  const control = access({ HUB_BASE_PATH: '/terminal-hub', HUB_ALLOWED_ORIGINS: 'https://example.test' });
  const req = { headers: { authorization: 'Basic ' + basic, origin: 'https://example.test', 'x-forwarded-proto': 'https' }, url: '/terminal-hub/api/sessions' };
  const res = response(); let next = false;
  control.middleware(req, res, () => { next = true; });
  assert.equal(next, true); assert.equal(req.url, '/api/sessions');
  assert.match(res.headers['Set-Cookie'], /; Secure$/);
  assert.match(res.headers['Set-Cookie'], /Path=\/terminal-hub/);
  const cookie = res.headers['Set-Cookie'].split(';')[0];
  const wsReq = { headers: { cookie, origin: 'https://example.test' }, url: '/terminal-hub/ws' };
  control.upgrade(wsReq, { write() { assert.fail('rejected'); }, destroy() { assert.fail('rejected'); } });
  assert.equal(wsReq.url, '/ws');
});

test('Untrusted origins and malformed Unicode cookie signatures are rejected', () => {
  const control = access({ HUB_ALLOWED_ORIGINS: 'https://example.test' });
  const res = response();
  control.middleware({ headers: { authorization: 'Basic ' + basic, origin: 'https://untrusted.test' } }, res, () => assert.fail('accepted'));
  assert.equal(res.statusCode, 403);
  const malformed = response();
  control.middleware({ headers: { cookie: `hub_windows_auth=${Date.now() + 60000}.${'中'.repeat(64)}` } }, malformed, () => assert.fail('accepted'));
  assert.equal(malformed.statusCode, 401);
});
