const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

test('production frontend caching validates HTML and keeps authentication ahead of immutable assets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-static-cache-'));
  const publicDir = path.join(directory, 'public');
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive:true });
  const html = '<!doctype html><title>Synthetic Hub build</title><script src="/assets/index-AbCdEF12.js"></script>';
  const assets = {
    'index-AbCdEF12.js':'console.log("Synthetic build");',
    'index-AbCdEF12.css':'body{color:#000}',
    'font-AbCdEF12.woff2':'synthetic font',
    'image-AbCdEF12.svg':'<svg xmlns="http://www.w3.org/2000/svg"/>',
    'runtime.js':'console.log("Unversioned runtime");',
    'index-short.js':'console.log("Not a build hash");',
    'page-AbCdEF12.html':'<title>HTML must always validate</title>',
  };
  fs.writeFileSync(path.join(publicDir, 'index.html'), html);
  for (const [name, body] of Object.entries(assets)) fs.writeFileSync(path.join(publicDir, 'assets', name), body);
  fs.writeFileSync(path.join(publicDir, 'outside-AbCdEF12.js'), 'console.log("Outside the build assets directory");');
  const basic = Buffer.from('synthetic-user:synthetic-password').toString('base64');
  const salt = 'synthetic-static-cache';
  const authFile = path.join(directory, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ salt, hash:createHash('sha256').update(salt + basic).digest('hex'), cookieKey:'synthetic-cookie-key' }));
  const env = { PORT:'0', HOST:'127.0.0.1', HUB_PUBLIC_DIR:publicDir, HUB_AUTH_FILE:authFile,
    HUB_STATE_FILE:path.join(directory, 'sessions.json'), HUB_BASE_PATH:'/hub', HUB_ALLOWED_ORIGINS:'https://trusted.test' };
  const serverDir = path.join(__dirname, '../server');
  let server;
  // Execute the real entry point to verify its middleware order. Only terminal
  // processes and notification transports are replaced, so no user sessions,
  // deployment credentials or private configuration are touched by this test.
  class SyntheticManager {
    async restore() {}
    list() { return []; }
    getSession() { throw new Error('No synthetic terminal exists'); }
    cleanup() {}
  }
  const accessModule = { exports:{} };
  vm.runInNewContext(fs.readFileSync(path.join(serverDir, 'services/access-control.js'), 'utf8'), {
    module:accessModule, require, Buffer, process:{ platform:'linux', env },
  });
  vm.runInNewContext(fs.readFileSync(path.join(serverDir, 'index.js'), 'utf8'), {
    __dirname:serverDir, console:{ log() {}, error:console.error },
    process:{ platform:'linux', env, on() {}, exit() { assert.fail('Synthetic server unexpectedly exited'); } },
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'http') return { createServer(app) { server = http.createServer(app); return server; } };
      if (name === './services/session-manager') return SyntheticManager;
      if (name === './services/access-control') return accessModule.exports;
      if (name === './ws') return () => {};
      if (name === './services/terminal-stream') return { setupTerminalStreams:() => ({ close() {} }) };
      return name.startsWith('.') ? require(path.join(serverDir, name)) : require(name);
    },
  });
  t.after(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive:true, force:true });
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}/hub`;
  const authorized = { Authorization:'Basic ' + basic };
  const request = (route, headers = authorized) => fetch(origin + route, { headers });
  for (const route of ['/', '/assets/index-AbCdEF12.js', '/api/sessions', '/terminal/missing/']) {
    const denied = await request(route, {});
    assert.equal(denied.status, 401, `Authentication precedes ${route}`);
    assert.doesNotMatch(denied.headers.get('Cache-Control') || '', /immutable|max-age=31536000/);
    assert.equal(await denied.text(), 'Authentication required');
  }
  for (const name of ['index-AbCdEF12.js', 'index-AbCdEF12.css', 'font-AbCdEF12.woff2', 'image-AbCdEF12.svg']) {
    const result = await request('/assets/' + name);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
    assert.equal(await result.text(), assets[name]);
    const conditionalDenied = await request('/assets/' + name, { 'If-None-Match':result.headers.get('ETag') });
    assert.equal(conditionalDenied.status, 401, 'A conditional cache request cannot bypass authentication');
    await conditionalDenied.text();
    const untrusted = await request('/assets/' + name, { ...authorized, Origin:'https://untrusted.test' });
    assert.equal(untrusted.status, 403);
    assert.doesNotMatch(untrusted.headers.get('Cache-Control') || '', /immutable/);
    await untrusted.json();
  }
  for (const route of ['/', '/index.html', '/reader/saved-session', '/assets/page-AbCdEF12.html',
    '/assets/runtime.js', '/assets/index-short.js', '/outside-AbCdEF12.js', '/assets/missing-AbCdEF12.js']) {
    const result = await request(route);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Cache-Control'), 'private, no-cache', `${route} must validate`);
    assert.ok(result.headers.get('ETag'));
    await result.text();
    const unchanged = await request(route, { ...authorized, 'If-None-Match':result.headers.get('ETag'), 'Cache-Control':'max-age=0' });
    assert.equal(unchanged.status, 304, `${route} validates without retransmitting an unchanged body`);
    assert.equal(unchanged.headers.get('Cache-Control'), 'private, no-cache');
    assert.equal(await unchanged.text(), '');
  }
  for (const route of ['/api/sessions', '/api/not-an-endpoint', '/terminal/missing/']) {
    const result = await request(route);
    assert.equal(result.headers.get('Cache-Control'), 'no-store', `${route} must not use the HTTP cache`);
    await result.text();
  }
});
