<script setup>
import { ref, onBeforeUnmount } from "vue";
import { useSessionStore } from "../stores/sessions";
import SessionCard from "./SessionCard.vue";

defineProps({
  collapsed: Boolean,
  mobile: Boolean, // New prop to detect if we are in mobile mode (optional, or just use css media queries)
});

const emit = defineEmits(["create"]);
const store = useSessionStore();
const list = ref(null);
const dragging = ref(null);
const dropTarget = ref(null);
const dropAfter = ref(false);
let pointerId = null;
let pointerY = 0;
let pointerX = 0;
let startY = 0;
let frame = null;
let moved = false;

function updateTarget() {
  const card = document.elementFromPoint(pointerX, pointerY)?.closest('[data-session-id]');
  const name = card?.dataset.sessionId;
  if (!card || !list.value?.contains(card) || name === dragging.value ||
      store.isPinned(name) !== store.isPinned(dragging.value)) {
    dropTarget.value = null;
    return;
  }
  dropTarget.value = name;
  const rect = card.getBoundingClientRect();
  dropAfter.value = pointerY > rect.top + rect.height / 2;
}
function autoScroll() {
  if (!dragging.value) return;
  const rect = list.value.getBoundingClientRect();
  if (moved && pointerX >= rect.left && pointerX <= rect.right) {
    const speed = pointerY < rect.top + 40 ? -10 : pointerY > rect.bottom - 40 ? 10 : 0;
    if (speed) { list.value.scrollTop += speed; updateTarget(); }
  }
  frame = requestAnimationFrame(autoScroll);
}
function dragMove(event) {
  if (event.pointerId !== pointerId) return;
  pointerX = event.clientX;
  pointerY = event.clientY;
  moved ||= Math.abs(pointerY - startY) > 5;
  if (moved) { event.preventDefault(); updateTarget(); }
}
function finishDrag(event) {
  if (event && event.pointerId !== pointerId) return;
  if (event?.type === 'pointerup' && moved && dropTarget.value) {
    store.reorderSession(dragging.value, dropTarget.value, dropAfter.value);
  }
  dragging.value = null;
  dropTarget.value = null;
  cancelAnimationFrame(frame);
  document.removeEventListener('pointermove', dragMove);
  document.removeEventListener('pointerup', finishDrag);
  document.removeEventListener('pointercancel', finishDrag);
  document.removeEventListener('keydown', cancelDrag);
}
function cancelDrag(event) { if (event.key === 'Escape') finishDrag(); }
function startDrag(event, name) {
  if (event.button !== 0) return;
  finishDrag();
  event.preventDefault();
  dragging.value = name;
  pointerId = event.pointerId;
  pointerX = event.clientX;
  pointerY = startY = event.clientY;
  moved = false;
  event.target.setPointerCapture(event.pointerId);
  document.addEventListener('pointermove', dragMove, { passive: false });
  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);
  document.addEventListener('keydown', cancelDrag);
  frame = requestAnimationFrame(autoScroll);
}
onBeforeUnmount(() => finishDrag());
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="sidebar-header">
      <h2 class="sidebar-title" v-show="!collapsed">Sessions</h2>
      <button
        class="icon-btn new-session-btn"
        @click="emit('create')"
        title="New Session"
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
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span v-show="!collapsed">New Session</span>
      </button>
    </div>

    <p v-if="!collapsed" class="sort-hint">拖动 ⠿ 排序 · ⋯ 管理会话<br>置顶与普通会话分别排序</p>
    <p v-if="store.layoutError" class="sort-hint" role="alert">{{ store.layoutError }}</p>
    <div ref="list" class="session-list" :class="{ sorting: dragging }">
      <SessionCard
        v-for="s in store.sortedSessions"
        :key="s.name"
        :session="s"
        :active="store.current === s.name"
        :collapsed="collapsed"
        :class="{ dragging: dragging === s.name, 'drop-before': dropTarget === s.name && !dropAfter, 'drop-after': dropTarget === s.name && dropAfter }"
        @drag-start="startDrag"
        @click="store.select(s.name)"
      />

      <div v-if="!store.sortedSessions.length" class="empty-hint" v-show="!collapsed">
        <p>No active sessions</p>
        <p class="sub-hint">Create one to get started</p>
      </div>
    </div>
    <details v-if="!collapsed" class="archive-section" open>
      <summary>归档（{{ store.archivedSessions.length }}）</summary>
      <p class="sort-hint">进程保留 30 分钟，到期自动终止</p>
      <div class="archive-list">
        <SessionCard v-for="s in store.archivedSessions" :key="s.name" :session="s" :collapsed="false" />
        <p v-if="!store.archivedSessions.length" class="sort-hint">暂无归档会话</p>
      </div>
    </details>
  </aside>
</template>

<style scoped>
.archive-section { flex-shrink:0; max-height:40%; overflow:auto; border-top:1px solid var(--border-color); padding:8px; }
.archive-section summary { cursor:pointer; font-size:12px; color:var(--text-secondary); padding:8px; }
.archive-list { display:flex; flex-direction:column; gap:4px; }

.sort-hint { margin: 0; padding: 4px 16px 8px; color: var(--text-tertiary); font-size: 11px; line-height: 1.5; }
.sorting { user-select: none; }
.session-card.dragging { opacity: 0.45; }
.session-card.drop-before { box-shadow: 0 -3px 0 var(--accent-primary); }
.session-card.drop-after { box-shadow: 0 3px 0 var(--accent-primary); }

.sidebar {
  width: var(--sidebar-width);
  border-right: 1px solid var(--border-color);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
  height: 100%;
  z-index: 20;
}

.sidebar.collapsed {
  width: 72px; /* collapsed width for icons */
}

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sidebar-title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-tertiary);
  font-weight: 600;
}

.new-session-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  background: var(--accent-primary);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  padding: 10px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.2s;
}

.new-session-btn:hover {
  background: var(--accent-hover);
}

.sidebar.collapsed .new-session-btn {
  padding: 10px 0;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.empty-hint {
  text-align: center;
  padding: 40px 10px;
  color: var(--text-tertiary);
}
.empty-hint p {
  font-size: 14px;
  margin-bottom: 4px;
}
.empty-hint .sub-hint {
  font-size: 12px;
  opacity: 0.7;
}

/* Mobile Responsive */
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--sidebar-width);
    transform: translateX(0);
    box-shadow: var(--shadow-md);
    z-index: 50; /* Above toolbar (30) */
  }

  .sidebar.collapsed {
    transform: translateX(-100%);
    width: var(--sidebar-width); /* maintain width when hidden */
  }
}
</style>
