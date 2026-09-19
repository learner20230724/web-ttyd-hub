<script setup>
import { ref, provide, watch } from "vue";
import Sidebar from "./components/Sidebar.vue";
import MobileTerminal from "./components/MobileTerminal.vue";
import TerminalView from "./components/TerminalView.vue";
import CreateDialog from "./components/CreateDialog.vue";
import Toast from "./components/Toast.vue";
import { useSessionStore } from "./stores/sessions";

const store = useSessionStore();
const sidebarCollapsed = ref(false);
const showCreateDialog = ref(false);
const toastRef = ref(null);
const readingKey = 'web-ttyd-hub.mobile-reading.v1';
let savedReading = {};
try { savedReading = JSON.parse(localStorage.getItem(readingKey)) || {}; } catch {}
const navigationOpen = ref(false);
const showExecution = ref(savedReading.showExecution === true);
const readingSize = ref(Number.isFinite(savedReading.fontSize) ? Math.max(4, Math.min(24, savedReading.fontSize)) : 16);
watch([showExecution, readingSize], () => {
  try { localStorage.setItem(readingKey, JSON.stringify({ showExecution: showExecution.value, fontSize: readingSize.value })); } catch {}
});

// Keep a phone in reading mode across rotation and keyboard resizing.
const isMobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
if (isMobile) sidebarCollapsed.value = true;
watch([() => store.current, () => store.loaded], ([name, loaded]) => {
  if (isMobile && loaded) sidebarCollapsed.value = Boolean(name);
});

provide("toast", toastRef);
store.init();

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

function handleMobileOverlayClick() {
  sidebarCollapsed.value = true;
}
</script>

<template>
  <div class="app-layout">
    <header class="toolbar glass">
      <div class="toolbar-left">
        <button
          class="icon-btn toggle-btn"
          @click="toggleSidebar"
          aria-label="Toggle Sidebar"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <div class="logo-wrapper">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" class="brand-logo">
            <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="2"/>
            <path d="M8 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M6 8l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M13 16h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <h1 class="toolbar-title">Web TTYd Hub</h1>
      </div>

      <div v-if="isMobile" class="reading-controls" aria-label="手机阅读设置">
        <button type="button" class="reading-control navigation-toggle" :class="{ selected: navigationOpen }"
          aria-label="方向键与回车" :aria-expanded="navigationOpen" aria-controls="mobile-navigation"
          @click="navigationOpen = !navigationOpen">✥</button>
        <button type="button" class="reading-control" :class="{ selected: showExecution }"
          :aria-pressed="showExecution" :aria-label="showExecution ? '隐藏执行过程' : '显示执行过程'"
          :title="showExecution ? '显示全部终端输出，点击只看回答' : '只看回答，点击显示全部终端输出'"
          @click="showExecution = !showExecution">{{ showExecution ? '全文' : '回答' }}</button>
        <button type="button" class="reading-control" aria-label="缩小字体" :disabled="readingSize <= 4" @click="readingSize = Math.max(4, readingSize - 1)">A−</button>
        <button type="button" class="reading-control" aria-label="放大字体" :disabled="readingSize >= 24" @click="readingSize = Math.min(24, readingSize + 1)">A+</button>
      </div>
    </header>

    <div class="main-area">
      <!-- Mobile Overlay -->
      <div
        class="sidebar-overlay"
        :class="{ show: !sidebarCollapsed }"
        @click="handleMobileOverlayClick"
      ></div>

      <Sidebar
        :collapsed="sidebarCollapsed"
        @create="showCreateDialog = true"
      />

      <MobileTerminal v-if="isMobile" :show-execution="showExecution" :font-size="readingSize" :navigation-open="navigationOpen" />
      <TerminalView v-else @create="showCreateDialog = true" />
    </div>

    <CreateDialog v-if="showCreateDialog" @close="showCreateDialog = false" />
    <Toast ref="toastRef" />
  </div>
</template>

<style scoped>
.reading-controls { display:flex; align-items:center; gap:2px; flex-shrink:0; }
.reading-control { min-width:36px; min-height:40px; padding:4px 6px; border:0; border-radius:7px; background:transparent; color:var(--text-secondary); font-size:13px; cursor:pointer; }
.navigation-toggle { font-size:20px; }
.reading-control.selected { color:#7dd3fc; background:#19344b; }
.reading-control:disabled { opacity:.35; cursor:default; }
@media (max-width: 767px) {
  .toolbar { padding:0 8px !important; gap:6px; }
  .toolbar-left { gap:8px !important; min-width:0; }
  .toolbar-title { font-size:14px !important; white-space:nowrap; }
  .logo-wrapper { display:none !important; }
}

.app-layout {
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.toolbar {
  height: var(--toolbar-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  z-index: 30; /* Desktop z-index */
  background: var(--bg-primary); /* Ensure background is opaque or semi-opaque */
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toggle-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
}
.toggle-btn:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.brand-logo {
  width: 20px;
  height: 20px;
  color: var(--accent-cyan);
}

.logo-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: linear-gradient(135deg, rgba(0, 255, 213, 0.1), rgba(180, 74, 255, 0.1));
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.toolbar-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.5px;
}

.main-area {
  min-height: 0;
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

/* Mobile Overlay */
.sidebar-overlay {
  display: none;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  z-index: 15; /* Below sidebar (20) */
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}

@media (max-width: 768px) {
  .sidebar-overlay {
    display: block;
  }
  .sidebar-overlay.show {
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
