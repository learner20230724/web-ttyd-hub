<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { hubUrl } from '../utils/base.mjs';
import { useSessionStore } from "../stores/sessions";

const emit = defineEmits(["close"]);
const store = useSessionStore();

const form = ref({
  name: "",
  command: "codex",
  cwd: "",
  resumeThreadId: "",
});

const loading = ref(false);
const error = ref("");
const projects = ref([]), projectsLoading = ref(false), projectsError = ref('');
const needsProject = computed(() => form.value.command === 'codex');
const historyRows = ref([]), historyLoading = ref(false), historyError = ref('');
const query = ref(''), total = ref(0), nextOffset = ref(null);
const preview = ref(null), previewLoading = ref(false), previewError = ref('');
let projectsController, historyController, previewController, searchTimer;
let historyRevision = 0, previewRevision = 0, closed = false;
const selectedThread = computed(() => historyRows.value.find(x => x.id === form.value.resumeThreadId));
const canSubmit = computed(() => !loading.value && (!needsProject.value ||
  (!projectsLoading.value && !historyLoading.value && !!form.value.cwd && (!form.value.resumeThreadId || !!selectedThread.value))));
function dateLabel(value) {
  return value ? new Date(value).toLocaleString() : '时间未知';
}
async function loadHistory(append = false) {
  clearTimeout(searchTimer);
  const revision = ++historyRevision;
  historyController?.abort(); historyController = new AbortController();
  historyError.value = '';
  if (!append) { historyRows.value = []; total.value = 0; nextOffset.value = null; form.value.resumeThreadId = ''; }
  if (!needsProject.value || !form.value.cwd) { historyLoading.value = false; return; }
  historyLoading.value = true;
  try {
    const params = new URLSearchParams({ cwd: form.value.cwd, q: query.value, offset: String(append ? nextOffset.value || 0 : 0) });
    const response = await fetch(hubUrl('/api/sessions/codex-history?' + params), { signal: historyController.signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '历史会话读取失败');
    if (closed || revision !== historyRevision) return;
    historyRows.value = append ? [...historyRows.value, ...data.sessions] : data.sessions;
    total.value = data.total; nextOffset.value = data.nextOffset;
  } catch (e) {
    if (!closed && revision === historyRevision && e.name !== 'AbortError') historyError.value = e.message;
  } finally { if (!closed && revision === historyRevision) historyLoading.value = false; }
}
watch(() => [form.value.cwd, form.value.command], () => {
  form.value.resumeThreadId = ''; query.value = '';
  loadHistory();
}, { flush: 'sync' });
watch(query, () => {
  clearTimeout(searchTimer); historyController?.abort(); historyRevision++;
  historyRows.value = []; form.value.resumeThreadId = ''; nextOffset.value = null;
  historyLoading.value = true;
  searchTimer = setTimeout(() => loadHistory(), 250);
});
watch(() => form.value.resumeThreadId, async id => {
  const revision = ++previewRevision;
  previewController?.abort(); preview.value = null; previewError.value = ''; previewLoading.value = false;
  if (!id) return;
  previewController = new AbortController(); previewLoading.value = true;
  try {
    const response = await fetch(hubUrl(`/api/sessions/codex-history/${encodeURIComponent(id)}?` + new URLSearchParams({ cwd: form.value.cwd })), { signal: previewController.signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '会话预览读取失败');
    if (!closed && revision === previewRevision) preview.value = data;
  } catch (e) {
    if (!closed && revision === previewRevision && e.name !== 'AbortError') previewError.value = e.message;
  } finally { if (!closed && revision === previewRevision) previewLoading.value = false; }
}, { flush: 'sync' });
async function refreshProjects() {
  projectsController?.abort();
  const controller = projectsController = new AbortController();
  projectsLoading.value = true; projectsError.value = '';
  try {
    const response = await fetch(hubUrl('/api/sessions/projects'), { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('项目列表读取失败');
    const data = await response.json();
    if (closed || controller !== projectsController) return;
    projects.value = data.projects || [];
    if (data.error) projectsError.value = data.error;
    if (!projects.value.some(p => p.path === form.value.cwd)) {
      let previous; try { previous = localStorage.getItem('home-terminal.last-project'); } catch {}
      form.value.cwd = projects.value.find(p => p.path === previous)?.path || projects.value.find(p => p.active)?.path || projects.value[0]?.path || '';
    }
    else await loadHistory();
  } catch (e) {
    if (!closed && controller === projectsController && e.name !== 'AbortError') { projectsError.value = e.message; projects.value = []; form.value.cwd = ''; }
  }
  finally { if (!closed && controller === projectsController) projectsLoading.value = false; }
}
onMounted(refreshProjects);
onBeforeUnmount(() => { closed = true; clearTimeout(searchTimer); projectsController?.abort(); historyController?.abort(); previewController?.abort(); });

const nameHint = computed(() => {
  return form.value.name ? form.value.name : `${form.value.command}-auto`;
});

async function handleSubmit() {
  if (!canSubmit.value) return;
  if (needsProject.value && !form.value.cwd) { error.value = '请先选择 Codex 项目目录'; return; }
  loading.value = true;
  error.value = "";
  try {
    await store.create({ ...form.value, cwd: needsProject.value ? form.value.cwd : undefined,
      resumeThreadId: needsProject.value ? form.value.resumeThreadId || undefined : undefined });
    if (needsProject.value) { try { localStorage.setItem('home-terminal.last-project', form.value.cwd); } catch {} }
    emit("close");
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal-content glass">
      <div class="modal-header">
        <h3>新建 / 恢复会话</h3>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <label class="form-group">
          <span class="label-text">Session Name (Optional)</span>
          <input
            v-model="form.name"
            type="text"
            :placeholder="nameHint"
            @keydown.enter="!$event.isComposing && $event.keyCode !== 229 && handleSubmit()"
            aria-describedby="name-help"
          />
        </label>

        <p id="name-help">支持中文、空格，最多 80 个字符 / Chinese names supported</p>
        <p v-if="error" role="alert">{{ error }}</p>

        <label class="form-group">
          <span class="label-text">Terminal Type / 终端类型</span>
          <select v-model="form.command">
            <option value="codex">Codex</option>
            <option v-for="s in store.shells.filter(s => s.id !== 'codex')" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
          <span v-if="form.command === 'codex'" class="label-text">自动运行 codex --yolo（关闭沙箱和审批）；仅限可信用户使用</span>
        </label>
        <label v-if="needsProject" class="form-group">
          <span class="label-text">项目目录 / 在哪个项目中打开 Codex</span>
          <select v-model="form.cwd" :disabled="projectsLoading" aria-label="Codex 项目目录">
            <option disabled value="">{{ projectsLoading ? '正在读取本机 Codex 项目…' : '请选择项目' }}</option>
            <option v-for="project in projects" :key="project.path" :value="project.path">{{ project.name }}{{ project.active ? '（当前项目）' : '' }} · {{ project.sessionCount || 0 }} 个会话</option>
          </select>
          <span class="label-text project-path">{{ form.cwd }}</span>
          <span v-if="projectsError" role="alert">{{ projectsError }}</span>
          <span v-else-if="!projectsLoading && !projects.length" class="label-text">暂无可用项目，请在服务器上使用 Codex，或设置 HUB_CWD。</span>
          <button type="button" class="btn" :disabled="projectsLoading" @click="refreshProjects">刷新项目列表</button>
        </label>
        <section v-if="needsProject && form.cwd" class="form-group" aria-label="Codex 历史会话">
          <label class="label-text" for="history-search">历史会话（当前服务器 · 当前项目）</label>
          <input id="history-search" v-model="query" type="search" placeholder="搜索标题或会话 ID" />
          <select v-model="form.resumeThreadId" :disabled="historyLoading" aria-label="选择 Codex 历史会话">
            <option value="">＋ 新建空白会话</option>
            <option v-for="thread in historyRows" :key="thread.id" :value="thread.id">
              {{ thread.title }} · {{ dateLabel(thread.updatedAt) }}{{ thread.hubSession ? ' · 已在 Hub 中' : '' }}
            </option>
          </select>
          <span v-if="historyLoading" class="label-text" role="status">正在加载历史会话…</span>
          <span v-else-if="historyError" role="alert">{{ historyError }}</span>
          <span v-else class="label-text">{{ historyRows.length }} / {{ total }} 个会话。{{ !total ? '可以直接新建会话。' : '选择后可预览并继续原对话。' }}</span>
          <div class="history-actions">
            <button type="button" class="btn" :disabled="historyLoading" @click="loadHistory()">刷新会话</button>
            <button v-if="nextOffset !== null" type="button" class="btn" :disabled="historyLoading" @click="loadHistory(true)">加载更多</button>
          </div>
          <span v-if="selectedThread" class="label-text project-path">{{ selectedThread.id }}</span>
          <span v-if="previewLoading" role="status">正在读取预览…</span>
          <span v-if="previewError" role="alert">{{ previewError }}</span>
          <div v-if="preview" class="history-preview" aria-label="历史对话预览">
            <p v-if="!preview.messages.length">暂无可预览的对话内容，可恢复会话后查看。</p>
            <article v-for="(message, index) in preview.messages" :key="index">
              <strong>{{ message.role === 'user' ? '你' : 'Codex' }}</strong>
              <p>{{ message.text }}</p>
            </article>
            <small>仅展示最近部分对话；恢复会话后可继续完整上下文。</small>
          </div>
        </section>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button
          class="btn btn-primary"
          @click="handleSubmit"
          :disabled="!canSubmit"
        >
          {{ loading ? "正在打开…" : form.resumeThreadId && needsProject ? "恢复 / 打开会话" : "新建会话" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.2s ease;
}

.modal-content {
  width: 100%;
  max-width: 560px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  margin: 16px;
  overflow: hidden;
  animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.modal-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 18px;
  padding: 4px;
  border-radius: 4px;
}
.close-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.modal-body {
  max-height: 65vh;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.label-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}
.project-path { overflow-wrap: anywhere; font-size: 12px; }
.history-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.history-preview { max-height: 240px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; }
.history-preview article + article { margin-top: 14px; }
.history-preview p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0; font-size: 13px; }
.history-preview small { color: var(--text-secondary); }

select,
input {
  width: 100%;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 10px;
  border-radius: var(--radius-md);
  outline: none;
  font-size: 14px;
  appearance: none;
}

select:focus,
input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

.modal-footer {
  padding: 16px 20px;
  background: var(--bg-primary);
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes slideUp {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
</style>
