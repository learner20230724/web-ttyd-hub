const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const modules = Promise.all([
  import('../frontend/node_modules/pinia/dist/pinia.mjs'),
  import('../frontend/src/stores/sessions.js'),
]);
const createdAt = '2026-10-20T00:00:00Z';
const session = phase => ({ name: 'restored', createdAt, status: 'running', shell: 'codex',
  activity: { available: true, phase, busy: phase === 'working', completed: phase === 'completed' ? 'done' : null } });

async function fixture(t, { rejectSocket = false } = {}) {
  const [{ createPinia, disposePinia }, { useSessionStore }] = await modules;
  const saved = new Map();
  const document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true });
  const window = new EventTarget();
  const sockets = [];
  class WebSocket {
    constructor() {
      if (rejectSocket) throw Error('Synthetic WebView socket constructor rejected');
      sockets.push(this);
    }
    close() { this.closed = true; }
  }
  const globals = { document, window, WebSocket, location: { protocol: 'http:', host: 'synthetic.test' },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } };
  const originals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let sessions = [session('working')], lists = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options?.method, undefined, 'Lifecycle recovery only reads; it never submits input or read receipts');
    if (url === '/api/sessions/shells') return Response.json({ platform: 'linux', shells: [] });
    assert.equal(url, '/api/sessions'); lists++;
    return Response.json({ sessions });
  });
  const pinia = createPinia(), store = useSessionStore(pinia);
  t.after(() => {
    disposePinia(pinia);
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { store, document, window, sockets, get lists() { return lists; }, complete() { sessions = [session('completed')]; } };
}

test('focus return without a visibility event reconciles task states and replaces a suspended socket without input', async t => {
  const f = await fixture(t);
  f.store.init(); await settle();
  assert.equal(f.store.activityState(f.store.sessions[0]), 'busy');
  f.complete();
  f.window.dispatchEvent(new Event('focus')); await settle();
  assert.equal(f.lists, 2, 'A WebView focus return cannot wait for another message or the periodic timer');
  assert.equal(f.store.activityState(f.store.sessions[0]), 'unread');
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[0].closed, true);
});

test('a restored browser page reconciles immediately even when visibility remains visible', async t => {
  const f = await fixture(t);
  f.store.init(); await settle();
  f.complete();
  f.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); await settle();
  assert.equal(f.store.activityState(f.store.sessions[0]), 'unread');
  assert.equal(f.lists, 2);
});

test('a rejected WebSocket constructor cannot abort initial rendering or disable the HTTP reconciliation fallback', async t => {
  const f = await fixture(t, { rejectSocket: true });
  assert.doesNotThrow(() => f.store.init()); await settle();
  assert.equal(f.store.loaded, true);
  assert.equal(f.store.activityState(f.store.sessions[0]), 'busy');
  f.complete(); f.window.dispatchEvent(new Event('focus')); await settle();
  assert.equal(f.store.activityState(f.store.sessions[0]), 'unread');
});

test('the five-second HTTP fallback recovers visible task states when WebView emits no foreground event', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t);
  f.document.hidden = true;
  f.store.init(); await settle();
  assert.equal(f.lists, 1, 'Initial HTTP reconciliation also runs when a WebView starts hidden');
  assert.equal(f.store.activityState(f.store.sessions[0]), 'busy');
  f.complete();
  t.mock.timers.tick(5000); await settle();
  assert.equal(f.lists, 1, 'Suspended pages do not poll HTTP in the background');
  f.document.hidden = false; // Deliberately emit no visibilitychange/focus/online.
  t.mock.timers.tick(5000); await settle();
  assert.equal(f.lists, 2);
  assert.equal(f.store.activityState(f.store.sessions[0]), 'unread');
});
