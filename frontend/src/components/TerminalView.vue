<script setup>
import { computed, ref, watch, nextTick, onBeforeUnmount } from "vue";
import { useSessionStore } from "../stores/sessions";

const store = useSessionStore();
const emit = defineEmits(["create"]);

const currentSession = computed(() => {
  return store.sessions.find((s) => s.name === store.current);
});

const iframeSrc = computed(() => {
  if (!currentSession.value || currentSession.value.status !== "running")
    return null;
  return `/terminal/${currentSession.value.name}`;
});

const terminalFrame = ref(null);
const historyPane = ref(null);
const historyOpen = ref(false);
const historyText = ref('');
const historyLoading = ref(false);
const historyError = ref('');
let detachWheel = () => {};
let requestController = null;

async function openHistory(fromWheel = false) {
  if (!currentSession.value || historyLoading.value) return;
  const name = currentSession.value.name;
  historyOpen.value = true;
  historyLoading.value = true;
  historyError.value = '';
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(name)}/history`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (controller.signal.aborted || currentSession.value?.name !== name) return;
    historyText.value = data.text;
    await nextTick();
    if (historyPane.value) {
      const pane = historyPane.value;
      // Start near the latest output; the first wheel-up reveals the preceding screen.
      pane.scrollTop = pane.scrollHeight - pane.clientHeight - (fromWheel ? pane.clientHeight * 0.6 : 0);
      pane.focus();
    }
  } catch (err) {
    if (!controller.signal.aborted) historyError.value = err.message;
  } finally {
    if (requestController === controller) historyLoading.value = false;
  }
}

function closeHistory() {
  requestController?.abort();
  historyLoading.value = false;
  historyOpen.value = false;
  terminalFrame.value?.contentWindow?.focus();
}

function bindWheel() {
  detachWheel();
  const doc = terminalFrame.value?.contentDocument;
  if (!doc) return;
  const onWheel = (event) => {
    if (event.ctrlKey || !event.deltaY) return; // Preserve browser zoom.
    event.preventDefault();
    event.stopImmediatePropagation();
    // Never let xterm's alternate-screen wheel handling send arrow keys to the shell.
    if (event.deltaY < 0 && !historyOpen.value) openHistory(true);
  };
  doc.addEventListener('wheel', onWheel, { capture: true, passive: false });
  detachWheel = () => doc.removeEventListener('wheel', onWheel, true);
}

watch(iframeSrc, () => {
  detachWheel();
  requestController?.abort();
  historyOpen.value = false;
  historyLoading.value = false;
  historyText.value = '';
  historyError.value = '';
});

onBeforeUnmount(() => { detachWheel(); requestController?.abort(); });
</script>

<template>
  <div class="terminal-area">
    <iframe
      v-if="iframeSrc"
      :key="iframeSrc"
      :src="iframeSrc"
      class="terminal-frame"
      ref="terminalFrame"
      title="交互终端 / Interactive terminal"
      @load="bindWheel"
    ></iframe>

    <div v-else class="welcome__container">
      <div class="welcome__content">
        <div class="logo-text">TTYd Hub</div>

        <template v-if="!currentSession">
          <p class="welcome__text">No active session selected.</p>
          <button class="btn btn-primary" @click="emit('create')">
            Create First Session
          </button>
        </template>

        <template v-else>
          <p class="welcome__text">
            Session <span class="highlight">{{ currentSession.displayName || currentSession.name }}</span> is
            currently stopped.
          </p>
          <p class="sub-text">Restart the session to continue.</p>
        </template>
      </div>
    </div>
    <button v-if="currentSession && !historyOpen" class="history-toggle" @click="openHistory(false)">
      历史输出 / History
    </button>
    <section v-if="historyOpen" class="history-panel" aria-label="历史输出 / Terminal history" @keydown.esc="closeHistory">
      <header class="history-toolbar">
        <span>历史输出 · 可滚动、拖选复制</span>
        <button :disabled="historyLoading" @click="openHistory(false)">刷新 / Refresh</button>
        <button @click="closeHistory">回到终端 / Live</button>
      </header>
      <p v-if="historyLoading" class="history-notice" role="status">正在读取历史输出…</p>
      <p v-if="historyError" class="history-notice" role="alert">{{ historyError }}</p>
      <pre ref="historyPane" class="history-output" tabindex="0" aria-label="历史内容 / History content">{{ historyText }}</pre>
    </section>

  </div>
</template>

<style scoped>
.history-toggle { position: absolute; right: 16px; top: 8px; z-index: 1; opacity: 0.85; }
.history-toggle, .history-toolbar button {
  background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: 6px;
  padding: 8px 12px; cursor: pointer;
}
.history-panel { position: absolute; inset: 0; display: flex; flex-direction: column; background: #080b10; color: #e2e8f0; z-index: 2; }
.history-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border-bottom: 1px solid var(--border-color); }
.history-toolbar span { flex: 1; font-size: 13px; }
.history-output { flex: 1; min-height: 0; margin: 0; padding: 16px; overflow: auto; overscroll-behavior: contain; white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; user-select: text; touch-action: pan-y; scrollbar-gutter: stable; }
.history-notice { margin: 0; padding: 8px 16px; font-size: 13px; }
.history-output:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }

.terminal-area {
  flex: 1;
  display: flex;
  overflow: hidden;
  background: #000; /* Terminal background */
  position: relative;
}

.terminal-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #000;
}

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
