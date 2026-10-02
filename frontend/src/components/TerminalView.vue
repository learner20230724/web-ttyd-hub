<script setup>
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSessionStore } from '../stores/sessions';
import { snapshotSequence, pendingWrapSequence, suppressQueryReplies } from '../utils/terminal-snapshot.mjs';
import { hubUrl } from '../utils/base.mjs';

const store = useSessionStore();
const emit = defineEmits(['create']);
const currentSession = computed(() => store.sessions.find(s => s.name === store.current));
const runningName = computed(() => currentSession.value?.status === 'running' ? currentSession.value.name : null);
// Windows workers own their ConPTY renderer; the native stream below uses tmux.
const nativeName = computed(() => store.platform && store.platform !== 'win32' ? runningName.value : null);
const windowsSrc = computed(() => store.platform === 'win32' && runningName.value
  ? hubUrl(`/terminal/${encodeURIComponent(runningName.value)}`) : null);
const host = ref(null);
const connection = ref('');
let dispose = () => {};
let revision = 0;

watch(nativeName, async name => {
  const version = ++revision;
  dispose();
  if (!name) return;
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
  let ws, timer, stopped = false, ready = false, attempt = 0, lastSize = '';
  let rendering = false, queuedBytes = 0;
  const renderQueue = [];
  const send = message => {
    if (ws?.readyState !== WebSocket.OPEN || (!ready && message.type !== 'resize')) return false;
    ws.send(JSON.stringify(message));
    return true;
  };
  const measure = () => {
    const size = fit.proposeDimensions();
    if (!size) return;
    const cols = Math.max(2, Math.min(500, size.cols));
    const rows = Math.max(2, Math.min(300, size.rows));
    const key = `${cols},${rows}`;
    if (key !== lastSize && send({ type: 'resize', cols, rows })) lastSize = key;
  };
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
    const { data, socket, bytes } = renderQueue.shift();
    queuedBytes -= bytes;
    if (socket !== ws) { renderNext(); return; }
    rendering = true;
    const done = () => { rendering = false; renderNext(); };
    if (data instanceof ArrayBuffer) { term.write(new Uint8Array(data), done); return; }
    const message = JSON.parse(data);
    if (message.type !== 'snapshot') { done(); return; }
    const buffer = term.buffer.active;
    const distance = buffer.baseY - buffer.viewportY;
    // Serialize resets with writes. A resize/reconnect during a large write must
    // not let the old snapshot append itself to the freshly reset terminal.
    term.reset();
    term.resize(message.meta.pane_width, message.meta.pane_height);
    term.write(snapshotSequence(message), () => {
      if (stopped) return;
      term.write(pendingWrapSequence(term, message.meta));
      const pending = Uint8Array.from(atob(message.pending), ch => ch.charCodeAt(0));
      term.write(pending, () => {
        if (!stopped && socket === ws && socket.readyState === WebSocket.OPEN) {
          if (distance > 0) term.scrollToLine(Math.max(0, term.buffer.active.baseY - distance));
          ready = true; attempt = 0; connection.value = '';
          term.options.disableStdin = false;
        }
        done();
      });
    });
  };
  const connect = () => {
    if (stopped) return;
    ready = false; term.options.disableStdin = true;
    connection.value = attempt ? '连接已断开，正在重连…' : '正在连接终端…';
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${hubUrl(`/ws/terminal/${encodeURIComponent(name)}`)}`);
    socket.binaryType = 'arraybuffer';
    ws = socket;
    socket.onopen = () => { lastSize = ''; measure(); };
    socket.onmessage = event => {
      if (stopped || socket !== ws) return;
      const bytes = typeof event.data === 'string' ? event.data.length * 2 : event.data.byteLength;
      queuedBytes += bytes;
      if (queuedBytes > 32 * 1024 * 1024) {
        renderQueue.length = 0; queuedBytes = 0; socket.close(); return;
      }
      renderQueue.push({ data: event.data, socket, bytes });
      renderNext();
    };
    socket.onclose = () => {
      if (stopped || socket !== ws) return;
      ready = false; term.options.disableStdin = true;
      connection.value = '连接已断开，正在重连…';
      timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000));
    };
    socket.onerror = () => socket.close();
  };
  connect(); term.focus();
  dispose = () => {
    stopped = true; clearTimeout(timer); observer.disconnect();
    element.removeEventListener('paste', paste, true);
    ws?.close(); term.dispose(); delete element.terminal;
  };
}, { immediate: true });
onBeforeUnmount(() => { revision++; dispose(); });
</script>

<template>
  <div class="terminal-area">
    <iframe v-if="windowsSrc" :src="windowsSrc" class="windows-terminal" title="交互终端 / Interactive terminal"></iframe>
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
