<script setup>
import { ref, nextTick, watch, computed, onBeforeUnmount } from "vue";
import { useSessionStore } from "../stores/sessions";

const props = defineProps({
  session: Object,
  active: Boolean,
  collapsed: Boolean,
});

const emit = defineEmits(["drag-start"]);
const store = useSessionStore();
const confirming = ref(false);
const editing = ref(false);
const draft = ref('');
const error = ref('');
const saving = ref(false);
const removing = ref(false);
const nameInput = ref(null);
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 10000);
onBeforeUnmount(() => clearInterval(clock));
const minutesLeft = computed(() => Math.max(0, Math.ceil((Date.parse(props.session.expiresAt) - now.value) / 60000)));
async function restoreFromMenu() {
  closeMenu(); error.value = '';
  try { await store.restoreSession(props.session.name); } catch (err) { error.value = err.message; }
}
const actionDialog = ref(null);
const menuOpen = ref(false);
function openMenu() { menuOpen.value = true; actionDialog.value?.showModal(); }
function closeMenu() { actionDialog.value?.close(); menuOpen.value = false; }
function pinFromMenu() { closeMenu(); store.togglePin(props.session.name); }
watch(() => props.collapsed, value => { if (value) closeMenu(); });

async function startRename() {
  closeMenu();
  draft.value = props.session.displayName || props.session.name;
  error.value = '';
  editing.value = true;
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
}

function onRenameEnter(event) {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  saveRename();
}

async function saveRename() {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await store.renameSession(props.session.name, draft.value);
    editing.value = false;
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}


function onClose(e, name) {
  closeMenu();
  e.stopPropagation();
  error.value = '';
  confirming.value = true;
}

async function confirmRemove(e, name) {
  e.stopPropagation();
  if (removing.value) return;
  removing.value = true;
  try {
    await store.removeSession(name, Boolean(props.session.archivedAt));
    confirming.value = false;
  } catch (err) {
    error.value = err.message;
  } finally { removing.value = false; }
}

function cancelRemove(e) {
  e.stopPropagation();
  confirming.value = false;
}
</script>

<template>
  <div
    class="session-card"
    :class="{ active, collapsed, pinned: store.isPinned(session.name) }"
    :data-session-id="session.name"
    :title="session.displayName || session.name"
  >
    <button v-if="!collapsed && !editing && !confirming && !session.archivedAt" class="drag-handle" type="button"
      title="拖动排序；也可按上下方向键" :aria-label="`拖动排序 ${session.displayName || session.name}`"
      @pointerdown.stop="emit('drag-start', $event, session.name)" @click.stop
      @keydown.up.prevent.stop="store.moveByKeyboard(session.name, -1)"
      @keydown.down.prevent.stop="store.moveByKeyboard(session.name, 1)">⠿</button>
    <div class="status-indicator" :class="store.activityState(session)" role="status" :aria-label="{busy: '正在回答', unread: '回答完成，未读', idle: '空闲或已读'}[store.activityState(session)]" :title="{busy: '正在回答', unread: '回答完成，未读', idle: '空闲或已读'}[store.activityState(session)]"></div>

    <Teleport to="body">
      <dialog ref="actionDialog" class="session-actions-dialog" :aria-label="`会话操作：${session.displayName || session.name}`"
        @click.stop="$event.target === actionDialog && closeMenu()" @cancel="menuOpen = false" @close="menuOpen = false">
        <div class="action-menu-content" @click.stop>
          <div class="action-menu-heading"><span>{{ session.displayName || session.name }}</span><button type="button" aria-label="关闭菜单" @click="closeMenu">×</button></div>
          <button v-if="!session.archivedAt" type="button" @click="pinFromMenu">{{ store.isPinned(session.name) ? '取消置顶' : '置顶会话' }}</button>
          <button v-if="!session.archivedAt" type="button" @click="startRename">修改名称</button>
          <button v-else type="button" @click="restoreFromMenu">恢复会话</button>
          <button type="button" class="delete-action" @click="onClose($event, session.name)">{{ session.archivedAt ? '彻底删除（立即终止任务）' : '移入归档（保留 30 分钟）' }}</button>
        </div>
      </dialog>
    </Teleport>
    <div class="card-content" v-show="!collapsed">
      <div class="card-top">
        <div class="session-name">{{ session.displayName || session.name }}</div>
        <button v-if="!confirming && !editing" class="session-menu-btn" type="button"
          aria-label="会话操作菜单" aria-haspopup="dialog" :aria-expanded="menuOpen"
          @click.stop="openMenu">⋯</button>
      </div>
      <div v-if="editing" class="rename-form" @click.stop @keydown.stop>
        <input ref="nameInput" v-model="draft" aria-label="会话名称 / Session name"
          :disabled="saving"
          @keydown.enter="onRenameEnter"
          @keydown.esc="!saving && (editing = false)" />
        <div class="rename-actions">
          <button type="button" :disabled="saving" @click="saveRename">{{ saving ? '保存中…' : '保存 / Save' }}</button>
          <button type="button" :disabled="saving" @click="editing = false">取消 / Cancel</button>
        </div>
        <p v-if="error" role="alert">{{ error }}</p>
      </div>
      <div v-else-if="confirming" class="confirm-bar" @click.stop>
        <p class="confirm-text">{{ session.archivedAt ? '彻底删除' : '归档' }}「{{ session.displayName || session.name }}」？{{ session.archivedAt ? '将立即终止该终端及其中运行的任务，无法撤销。' : '会话和进程将保留 30 分钟，可从归档恢复；到期自动终止。' }}</p>
        <div class="confirm-actions">
          <button type="button" class="confirm-no" :disabled="removing" @click="cancelRemove($event)">取消，保留会话</button>
          <button type="button" class="confirm-yes" :disabled="removing" @click="confirmRemove($event, session.name)">{{ removing ? '处理中…' : session.archivedAt ? '彻底删除并终止任务' : '移入归档' }}</button>
        </div>
        <p v-if="error" role="alert">{{ error }}</p>
      </div>
      <p v-if="error && !editing && !confirming" role="alert">{{ error }}</p>
      <div v-if="!editing && !confirming" class="session-info">
        <span v-if="session.archivedAt">{{ minutesLeft }} 分钟后清理</span>
        <span v-else class="pid">PID: {{ session.pid }}</span>
        <span class="status-text">{{ session.status }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drag-handle { background: none; border: 0; padding: 4px 0; min-width: 22px; min-height: 36px; color: var(--text-tertiary); font-size: 22px; cursor: grab; touch-action: none; flex-shrink: 0; }
.drag-handle:active { cursor: grabbing; }
.session-card.pinned { border-left-color: var(--accent-primary); }
.session-menu-btn { background:transparent; border:0; border-radius:6px; color:var(--text-secondary); font-size:24px; cursor:pointer; }
.session-menu-btn:hover { background:var(--bg-tertiary); }
.session-actions-dialog { margin:auto; padding:0; width:min(280px, calc(100vw - 32px)); max-height:calc(100dvh - 40px); overflow:auto; border:1px solid var(--border-color); border-radius:12px; background:var(--bg-primary); color:var(--text-primary); box-shadow:0 16px 50px #0008; }
.session-actions-dialog::backdrop { background:#0006; }
.action-menu-content { display:grid; gap:4px; padding:12px; }
.action-menu-heading { display:flex; align-items:center; gap:8px; padding:0 4px 8px; font-size:13px; }
.action-menu-heading span { flex:1; min-width:0; overflow-wrap:anywhere; }
.action-menu-content button { min-height:44px; padding:10px 12px; border:0; border-radius:6px; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
.action-menu-content button:hover, .action-menu-content button:focus-visible { background:var(--bg-tertiary); }
.action-menu-heading button { flex:0 0 40px; text-align:center; padding:0; font-size:24px; }
.action-menu-content .delete-action { color:var(--danger); border-top:1px solid var(--border-color); margin-top:4px; }

.rename-form { display: grid; gap: 8px; padding-top: 6px; }
.rename-form input {
  width: 100%; min-width: 0; padding: 8px;
  background: var(--bg-primary); color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: 4px;
}
.rename-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.rename-actions button {
  padding: 6px; cursor: pointer; background: var(--bg-primary);
  color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px;
}
.rename-form [role="alert"] { font-size: 12px; color: var(--danger); overflow-wrap: anywhere; }

.session-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s;
  border: 1px solid transparent;
  color: var(--text-secondary);
}

.session-card:hover {
  background: var(--bg-card-hover);
  color: var(--text-primary);
}

.session-card.active {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-color: var(--border-color);
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-tertiary);
  flex-shrink: 0;
}

.status-indicator.unread {
  background: var(--success);
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
}

.status-indicator.busy { width:12px; height:12px; background:transparent; border:2px solid #506078; border-top-color:#70cbff; animation:answer-spin .8s linear infinite; }
@keyframes answer-spin { to { transform:rotate(360deg); } }

.card-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card-top {
  display: flex;
  align-items: center;
  gap: 4px;
}

.session-name {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
  flex: 1;
  min-width: 0;
}

.session-info {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-tertiary);
}

.confirm-bar {
  display: grid;
  gap: 10px;
  font-size: 12px;
}

.confirm-text { color: var(--danger); font-weight: 500; line-height: 1.6; overflow-wrap: anywhere; }
.confirm-actions { display: flex; flex-direction: column; gap: 8px; }
.confirm-actions button { min-height: 40px; padding: 8px; }
.card-top > button { flex: 0 0 36px; width: 36px; height: 40px; }


.confirm-yes,
.confirm-no {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
  color: var(--text-secondary);
}

.confirm-yes:hover {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

.confirm-no:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* Collapsed state centering */
.session-card.collapsed {
  justify-content: center;
  padding: 12px;
}
.session-card.collapsed .status-indicator {
  width: 10px;
  height: 10px;
}
</style>
