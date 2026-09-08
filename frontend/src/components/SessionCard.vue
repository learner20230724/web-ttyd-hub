<script setup>
import { ref, nextTick } from "vue";
import { useSessionStore } from "../stores/sessions";

const props = defineProps({
  session: Object,
  active: Boolean,
  collapsed: Boolean,
});

const store = useSessionStore();
const confirming = ref(false);
const editing = ref(false);
const draft = ref('');
const error = ref('');
const saving = ref(false);
const nameInput = ref(null);

async function startRename() {
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
  e.stopPropagation();
  confirming.value = true;
}

async function confirmRemove(e, name) {
  e.stopPropagation();
  try {
    await store.removeSession(name);
  } catch (err) {
    console.error(err);
  }
  confirming.value = false;
}

function cancelRemove(e) {
  e.stopPropagation();
  confirming.value = false;
}
</script>

<template>
  <div
    class="session-card"
    :class="{ active, collapsed }"
    :title="session.displayName || session.name"
  >
    <div class="status-indicator" :class="session.status"></div>

    <div class="card-content" v-show="!collapsed">
      <div class="card-top">
        <div class="session-name">{{ session.displayName || session.name }}</div>
        <button v-if="!confirming && !editing" class="rename-btn" type="button"
          title="重命名 / Rename" aria-label="重命名会话 / Rename session"
          @click.stop="startRename">✎</button>
        <button
          v-if="!confirming && !editing"
          class="close-btn"
          title="Delete session"
          @click="onClose($event, session.name)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
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
      <div v-else-if="confirming" class="confirm-bar">
        <span class="confirm-text">Delete?</span>
        <button class="confirm-yes" @click="confirmRemove($event, session.name)">Yes</button>
        <button class="confirm-no" @click="cancelRemove($event)">No</button>
      </div>
      <div v-else class="session-info">
        <span class="pid">PID: {{ session.pid }}</span>
        <span class="status-text">{{ session.status }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rename-btn {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  min-width: 32px;
  min-height: 32px;
}
.rename-btn:hover, .rename-btn:focus-visible { color: var(--accent-primary); }
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
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
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

.status-indicator.running {
  background: var(--success);
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
}

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
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.close-btn {
  display: none;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  flex-shrink: 0;
}
.session-card:hover .close-btn {
  display: flex;
}
.close-btn:hover {
  background: var(--bg-tertiary);
  color: var(--danger);
}

.session-info {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-tertiary);
}

.confirm-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.confirm-text {
  color: var(--danger);
  font-weight: 500;
}

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
