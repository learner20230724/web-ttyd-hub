<script setup>
import { computed, ref, watch, nextTick, onBeforeUnmount } from "vue";
import { useSessionStore } from "../stores/sessions";

import { peekContent, loadContent, fetchContent } from "../utils/session-content.mjs";
import { ansiToRuns } from "../utils/ansi.mjs";

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
const touchDevice = window.matchMedia('(pointer: coarse)').matches;
const historyOpen = ref(false);
const historyText = ref('');
const historyRuns = computed(() => ansiToRuns(historyText.value));
const historyLoading = ref(false);
const historyError = ref('');
const historyRevision = ref(0);
let composing = false;
let compositionScroll = 0;
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
  const selected = currentSession.value;
  const cached = peekContent(selected, 'full');
  let shown = false;
  async function show(entry) {
    if (!entry || controller.signal.aborted || currentSession.value?.name !== name) return;
    const text = entry.data.ansi ?? entry.data.text ?? '';
    if (historyText.value !== text) historyText.value = text;
    if (!shown) {
      shown = true;
      await nextTick();
      if (controller.signal.aborted) return;
      const pane = historyPane.value;
      if (pane) {
        pane.scrollTop = pane.scrollHeight - pane.clientHeight - (fromWheel ? pane.clientHeight * 0.6 : 0);
        pane.focus({ preventScroll: true });
      }
    }
  }
  historyText.value = '';
  if (cached) await show(cached);
  else void loadContent(selected, 'full').then(entry => { if (!shown) show(entry); });
  try {
    await show(await fetchContent(selected, 'full', { mobile:false }));
  } catch (err) {
    if (!controller.signal.aborted) historyError.value = shown ? '正在显示缓存，暂时无法更新。' : err.message;
  } finally {
    if (requestController === controller) historyLoading.value = false;
  }
}

function terminalInput(text) {
  if (!historyOpen.value || !text) return false;
  const term = terminalFrame.value?.contentWindow?.term;
  if (!term?.paste || term.options?.disableStdin || currentSession.value?.status !== 'running') {
    historyError.value = '终端尚未就绪，请回到终端连接后再输入。';
    return false;
  }
  // Use xterm's own paste path, including bracketed-paste handling for multiline text.
  // Never synthesize individual key events or add an Enter after pasted content.
  term.paste(text);
  closeHistory();
  return true;
}

function historyBeforeInput(event) {
  if (!historyOpen.value) { event.preventDefault(); return; }
  if (composing || event.isComposing || event.inputType === 'insertCompositionText') return;
  event.preventDefault(); // Keep the snapshot immutable (including deletion/formatting).
  if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
    terminalInput(event.data);
  }
}

function historyPaste(event) {
  event.preventDefault();
  const text = event.clipboardData?.getData('text/plain');
  if (text) terminalInput(text);
}

function historyCompositionStart() {
  composing = true;
  compositionScroll = historyPane.value?.scrollTop || 0;
}

function historyCompositionEnd(event) {
  composing = false;
  if (!historyOpen.value) return;
  // The browser temporarily owns the editable DOM during IME composition.
  // A fresh pre restores the snapshot after cancellation or an unavailable terminal.
  if (!terminalInput(event.data)) {
    historyRevision.value++;
    nextTick(() => {
      historyPane.value?.focus({ preventScroll: true });
      if (historyPane.value) historyPane.value.scrollTop = compositionScroll;
    });
  }
}

function historyKeydown(event) {
  if (event.key === 'Escape' && !composing && !event.isComposing) {
    event.preventDefault();
    closeHistory();
  }
}

function closeHistory() {
  requestController?.abort();
  historyLoading.value = false;
  historyOpen.value = false;
  composing = false;
  const win = terminalFrame.value?.contentWindow;
  if (win?.term?.focus) win.term.focus();
  else win?.focus();
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
  let touchStart = null;
  const onTouchStart = event => {
    touchStart = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, time: Date.now() } : null;
  };
  const onTouchMove = event => {
    if (!touchStart || event.touches.length !== 1 || Date.now() - touchStart.time > 450 ||
        doc.defaultView?.term?.getSelection?.()) return;
    const dx = event.touches[0].clientX - touchStart.x;
    const dy = event.touches[0].clientY - touchStart.y;
    // Reserve a quick vertical gesture for history, not xterm's arrow-key emulation.
    // Long presses, selection dragging and two-finger zoom keep their native behavior.
    if (Math.abs(dy) > Math.abs(dx)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (Math.abs(dy) > 28) { touchStart = null; openHistory(true); }
    }
  };
  const onTouchEnd = () => { touchStart = null; };
  doc.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  doc.addEventListener('touchend', onTouchEnd, true);
  doc.addEventListener('touchcancel', onTouchEnd, true);
  detachWheel = () => {
    doc.removeEventListener('wheel', onWheel, true);
    doc.removeEventListener('touchstart', onTouchStart, true);
    doc.removeEventListener('touchmove', onTouchMove, true);
    doc.removeEventListener('touchend', onTouchEnd, true);
    doc.removeEventListener('touchcancel', onTouchEnd, true);
  };
}

watch(iframeSrc, () => {
  detachWheel();
  requestController?.abort();
  historyOpen.value = false;
  historyLoading.value = false;
  historyText.value = '';
  historyError.value = '';
  composing = false;
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
    <section v-if="historyOpen" class="history-panel" aria-label="历史输出 / Terminal history" @keydown="historyKeydown">
      <header class="history-toolbar">
        <span>历史输出 · 输入或粘贴即可返回终端</span>
        <button :disabled="historyLoading" @click="openHistory(false)">刷新 / Refresh</button>
        <button data-action="close-history" @click="closeHistory">回到终端 / Live</button>
      </header>
      <p v-if="historyLoading && !historyText" class="history-notice" role="status">正在读取历史输出…</p>
      <p v-if="historyError" class="history-notice" role="alert">{{ historyError }}</p>
      <pre :key="historyRevision" ref="historyPane" class="history-output" tabindex="0"
        :inputmode="touchDevice ? 'none' : 'text'" contenteditable="true" spellcheck="false" autocapitalize="off" autocorrect="off"
        aria-label="历史内容，输入或粘贴返回终端 / History content"
        @beforeinput="historyBeforeInput" @paste="historyPaste"
        @compositionstart="historyCompositionStart" @compositionend="historyCompositionEnd"
        @drop.prevent @cut.prevent><span v-for="(run, index) in historyRuns" :key="index" :style="run.style">{{ run.text }}</span></pre>
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
.history-panel { position: absolute; inset: 0; display: flex; flex-direction: column; background: #000000; color: #ffffff; z-index: 2; }
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
