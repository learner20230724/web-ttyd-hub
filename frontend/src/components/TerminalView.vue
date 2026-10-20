<script setup>
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSessionStore } from '../stores/sessions';
import { snapshotSequence, pendingWrapSequence, suppressQueryReplies } from '../utils/terminal-snapshot.mjs';
import { hubUrl } from '../utils/base.mjs';
import { loadContent, peekContent, saveContent } from '../utils/session-content.mjs';
import { terminalCache, validSnapshot, applyTerminalDelta, encodeTerminalBytes, decodeTerminalBytes } from '../utils/terminal-cache.mjs';

const store = useSessionStore();
const emit = defineEmits(['create']);
const currentSession = computed(() => store.sessions.find(s => s.name === store.current));
const runningName = computed(() => currentSession.value?.status === 'running' ? currentSession.value.name : null);
// Windows workers own their ConPTY renderer; the native stream below uses tmux.
const nativeName = computed(() => store.platform && store.platform !== 'win32' ? runningName.value : null);
const nativeKey = computed(() => nativeName.value ? JSON.stringify([nativeName.value, currentSession.value.createdAt || '']) : null);
const windowsSrc = computed(() => store.platform === 'win32' && runningName.value && !store.cachedSnapshot
  ? hubUrl(`/terminal/${encodeURIComponent(runningName.value)}`) : null);
const host = ref(null);
const connection = ref('');
const windowsReady = ref(false);
let nativeReadGuard = () => false;
const releaseReadGuard = store.setReadGuard(selected => store.platform === 'win32'
  ? windowsReady.value && !store.cachedSnapshot && runningName.value === selected.name
  : nativeReadGuard(selected));
watch(windowsSrc, () => { windowsReady.value = false; });
function windowsLoaded() { windowsReady.value = true; store.markRead(); }
let dispose = () => {};
let revision = 0;

watch(nativeKey, async key => {
  const version = ++revision;
  dispose();
  nativeReadGuard = () => false;
  if (!key) return;
  const [name, createdAt] = JSON.parse(key), session = { name, createdAt };
  await nextTick();
  if (version !== revision || !host.value) return;
  const element = host.value;
  const term = new Terminal({
    cursorBlink: true, fontSize: 15, scrollback: 20000,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    theme: { background: '#000000', foreground: '#ffffff' },
    scrollOnUserInput: true, smoothScrollDuration: 100, disableStdin: true,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(element);
  suppressQueryReplies(term);
  // Keep the terminal API available for local diagnostics and accessibility.
  element.terminal = term;
  let ws, timer, cacheTimer, initialTimer, stopped = false, ready = false, initializedSocket = false, attempt = 0, lastSize = '';
  let rendering = false, queuedBytes = 0;
  let cacheState = null, tailBytes = 0, liveSnapshot = false, checkpointPending = false;
  let renderedCompleted = null, renderedSnapshot = false;
  const renderQueue = [];
  const confirmedSession = () => !store.cachedSnapshot && nativeKey.value === key;
  nativeReadGuard = selected => !stopped && ready && renderedSnapshot && confirmedSession() &&
    selected.name === name && (selected.createdAt || '') === createdAt &&
    selected.activity?.completed === renderedCompleted && !rendering && !renderQueue.length &&
    term.buffer.active.viewportY === term.buffer.active.baseY;
  const persistCache = () => {
    clearTimeout(cacheTimer); cacheTimer = null;
    try {
      if (cacheState) saveContent(session, 'terminal', { ...cacheState, updates: cacheState.updates.slice() });
    } catch {} // A failed optional cache must never interrupt a terminal.
  };
  const scheduleCache = () => {
    if (!cacheTimer) cacheTimer = setTimeout(persistCache, 1200);
  };
  const send = message => {
    if (ws?.readyState !== WebSocket.OPEN || (!ready && message.type !== 'resize')) return false;
    if (message.type === 'resize' && !initializedSocket) return false;
    ws.send(JSON.stringify(message));
    return true;
  };
  const measure = () => {
    const size = fit.proposeDimensions();
    if (!size) return;
    const cols = Math.max(2, Math.min(500, size.cols));
    const rows = Math.max(2, Math.min(300, size.rows));
    const key = `${cols},${rows}`;
    if (key !== lastSize && send({ type: 'resize', cols, rows, cache: 'splice-v1', generation: createdAt, digest: cacheState?.snapshot.digest })) lastSize = key;
  };
  const refreshRead = () => {
    const completed = currentSession.value?.activity?.completed;
    // A later completion on the metadata socket does not prove its terminal
    // output was rendered. Obtain a cheap authoritative snapshot/checkpoint.
    if (ready && confirmedSession() && completed && completed !== renderedCompleted &&
        cacheState?.snapshot.completed !== completed && !checkpointPending) {
      checkpointPending = send({ type: 'checkpoint' });
    }
    store.markRead();
  };
  const stopCompletionWatch = watch(() => currentSession.value?.activity?.completed, refreshRead, { flush: 'post' });
  term.onScroll(() => store.markRead());
  const input = (type, data) => {
    if (send({ type, data })) term.scrollToBottom();
  };
  term.onData(data => input('input', data));
  term.onBinary(data => input('binary', data));
  term.attachCustomWheelEventHandler(event => {
    if (event.ctrlKey) return false;
    // Full-screen programs with mouse support own their scrolling. Never turn a
    // wheel gesture into Up/Down keys in programs without mouse support.
    if (term.buffer.active.type === 'alternate' && term.modes.mouseTrackingMode === 'none') {
      event.preventDefault(); return false;
    }
    return true;
  });
  term.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && term.hasSelection()) {
      document.execCommand('copy');
      event.preventDefault(); return false;
    }
    return true;
  });
  const paste = event => {
    const text = event.clipboardData?.getData('text/plain');
    if (text === undefined) return;
    event.preventDefault(); event.stopImmediatePropagation();
    input('paste', text); term.focus();
  };
  element.addEventListener('paste', paste, true);
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  const renderNext = () => {
    if (rendering || stopped || !renderQueue.length) return;
    const { data, socket, bytes, cached = false, updates = [] } = renderQueue.shift();
    queuedBytes -= bytes;
    if (!cached && socket !== ws) { renderNext(); return; }
    rendering = true;
    const done = () => { rendering = false; renderNext(); refreshRead(); };
    if (data instanceof ArrayBuffer) { term.write(new Uint8Array(data), done); return; }
    const message = data;
    const buffer = term.buffer.active;
    const distance = buffer.baseY - buffer.viewportY;
    // Serialize resets with writes. A resize/reconnect during a large write must
    // not let the old snapshot append itself to the freshly reset terminal.
    term.reset();
    term.resize(message.meta.pane_width, message.meta.pane_height);
    term.write(snapshotSequence(message), () => {
      if (stopped) return;
      term.write(pendingWrapSequence(term, message.meta));
      term.write(decodeTerminalBytes(message.pending), () => {
        const finish = () => {
          if (!cached && !stopped && socket === ws && socket.readyState === WebSocket.OPEN) {
            if (distance > 0) {
              // Snapshot replay temporarily puts the viewport at the bottom.
              // Restore synchronously: an animated restore would leave a brief
              // bottom position that could acknowledge an unseen completion.
              const duration = term.options.smoothScrollDuration;
              term.options.smoothScrollDuration = 0;
              term.scrollToLine(Math.max(0, term.buffer.active.baseY - distance));
              term.options.smoothScrollDuration = duration;
            }
            ready = true; attempt = 0; connection.value = '';
            term.options.disableStdin = false;
            renderedSnapshot = true; renderedCompleted = message.completed;
          }
          done();
        };
        let index = 0;
        const replay = () => {
          if (stopped) return;
          if (index === updates.length) { finish(); return; }
          term.write(decodeTerminalBytes(updates[index++]), replay);
        };
        replay();
      });
    });
  };
  const restoreCache = entry => {
    if (stopped || liveSnapshot || cacheState) return;
    const data = terminalCache(entry?.data);
    if (!data) return;
    cacheState = data;
    tailBytes = data.updates.reduce((bytes, update) => bytes + update.length * 0.75, 0);
    connection.value = '本地缓存，正在连接终端…';
    renderQueue.push({ data: data.snapshot, updates: data.updates.slice(), cached: true, bytes: 0 });
    renderNext();
  };
  restoreCache(peekContent(session, 'terminal'));
  // Storage never delays opening the live socket. A late disk result cannot
  // replace a current server snapshot, including during a session switch.
  const cachedLoad = loadContent(session, 'terminal').then(restoreCache);
  const connect = () => {
    if (stopped || !confirmedSession()) return;
    ready = false; initializedSocket = false; term.options.disableStdin = true;
    connection.value = attempt ? '连接已断开，正在重连…' : '正在连接终端…';
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${hubUrl(`/ws/terminal/${encodeURIComponent(name)}`)}`);
    socket.binaryType = 'arraybuffer';
    ws = socket;
    socket.onopen = () => {
      const begin = () => {
        if (stopped || socket !== ws || socket.readyState !== WebSocket.OPEN || initializedSocket) return;
        clearTimeout(initialTimer); initializedSocket = true; lastSize = ''; measure();
      };
      if (cacheState) begin();
      else {
        // Open the network immediately, with a brief bounded grace period for a
        // fast disk result to advertise its baseline. Blocked storage cannot
        // delay the live snapshot or keep the terminal waiting for IndexedDB.
        initialTimer = setTimeout(begin, 25);
        void cachedLoad.then(begin);
      }
    };
    socket.onmessage = event => {
      if (stopped || socket !== ws) return;
      clearTimeout(initialTimer);
      const bytes = typeof event.data === 'string' ? event.data.length * 2 : event.data.byteLength;
      queuedBytes += bytes;
      if (queuedBytes > 32 * 1024 * 1024) {
        renderQueue.length = 0; queuedBytes = 0; socket.close(); return;
      }
      let data = event.data;
      if (data instanceof ArrayBuffer) {
        if (cacheState && tailBytes < 8 * 1024 * 1024 && cacheState.updates.length < 8192) {
          cacheState.updates.push(encodeTerminalBytes(data)); tailBytes += data.byteLength;
          scheduleCache();
          if ((tailBytes > 4 * 1024 * 1024 || cacheState.updates.length > 4096) && !checkpointPending) {
            checkpointPending = send({ type: 'checkpoint' });
          }
        }
      } else {
        try {
          const message = JSON.parse(data);
          data = message.type === 'snapshot-delta' ? applyTerminalDelta(cacheState?.snapshot, message) : message;
          if (!validSnapshot(data) || data.generation !== createdAt || !Object.hasOwn(data, 'completed')) throw new Error('Invalid terminal snapshot');
        } catch {
          // An evicted or corrupted local baseline must retry without a hint;
          // never append a partial snapshot or enable input against cached data.
          cacheState = null; queuedBytes -= bytes; socket.close(); return;
        }
        liveSnapshot = true;
        cacheState = { version: 1, snapshot: data, updates: [] };
        tailBytes = 0; checkpointPending = false; scheduleCache();
      }
      renderQueue.push({ data, socket, bytes });
      renderNext();
    };
    socket.onclose = () => {
      if (stopped || socket !== ws) return;
      clearTimeout(initialTimer);
      ready = false; term.options.disableStdin = true;
      connection.value = '连接已断开，正在重连…';
      timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000));
    };
    socket.onerror = () => socket.close();
  };
  // Cached metadata can refer to a deleted session whose name was reused.
  // Restore it for reading, but wait for the complete authoritative list before
  // opening a socket that could resize/attach to the replacement session.
  const stopNetworkWatch = watch([() => store.cachedSnapshot, nativeKey], () => {
    if (!ws && confirmedSession()) connect();
  }, { immediate: true, flush: 'post' });
  term.focus();
  window.addEventListener('pagehide', persistCache);
  dispose = () => {
    persistCache(); window.removeEventListener('pagehide', persistCache);
    stopNetworkWatch();
    stopCompletionWatch();
    stopped = true; clearTimeout(timer); clearTimeout(initialTimer); observer.disconnect();
    element.removeEventListener('paste', paste, true);
    ws?.close(); term.dispose(); delete element.terminal;
  };
}, { immediate: true });
onBeforeUnmount(() => { revision++; dispose(); releaseReadGuard(); });
</script>

<template>
  <div class="terminal-area">
    <iframe v-if="windowsSrc" :src="windowsSrc" class="windows-terminal" title="交互终端 / Interactive terminal" @load="windowsLoaded"></iframe>
    <div v-else-if="nativeName" ref="host" class="terminal-host" aria-label="交互终端 / Interactive terminal"></div>
    <div v-if="nativeName && connection" class="connection-status" role="status">{{ connection }}</div>
    <div v-if="!runningName" class="welcome__container">
      <div class="welcome__content">
        <div class="logo-text">TTYd Hub</div>
        <template v-if="!currentSession">
          <p class="welcome__text">No active session selected.</p>
          <button class="btn btn-primary" @click="emit('create')">Create First Session</button>
        </template>
        <template v-else>
          <p class="welcome__text">Session <span class="highlight">{{ currentSession.displayName || currentSession.name }}</span> is currently stopped.</p>
          <p class="sub-text">Restart the session to continue.</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-area { flex: 1; min-width: 0; min-height: 0; display: flex; overflow: hidden; background: #000; position: relative; }
.terminal-host { width: 100%; height: 100%; min-width: 0; padding: 8px 4px 4px 8px; box-sizing: border-box; overflow: hidden; }
.terminal-host :deep(.xterm) { height: 100%; }
.windows-terminal { width: 100%; height: 100%; border: 0; }
.connection-status { position: absolute; right: 12px; top: 8px; z-index: 1; background: var(--bg-secondary); color: var(--text-secondary); border-radius: 6px; padding: 6px 10px; font-size: 12px; pointer-events: none; }

.welcome__container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  background-image: radial-gradient(
    circle at center,
    var(--bg-secondary) 0%,
    var(--bg-primary) 100%
  );
}

.welcome__content {
  text-align: center;
  max-width: 400px;
  padding: 40px;
}

.logo-text {
  font-size: 32px;
  font-weight: 700;
  margin-bottom: 24px;
  background: linear-gradient(
    135deg,
    var(--text-primary),
    var(--text-secondary)
  );
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  letter-spacing: -1px;
}

.welcome__text {
  color: var(--text-secondary);
  font-size: 16px;
  margin-bottom: 24px;
}

.highlight {
  color: var(--text-primary);
  font-weight: 600;
}

.sub-text {
  color: var(--text-tertiary);
  font-size: 14px;
}
</style>
