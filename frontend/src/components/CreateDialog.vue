<script setup>
import { ref, computed, onMounted } from "vue";
import { hubUrl } from '../utils/base.mjs';
import { useSessionStore } from "../stores/sessions";

const emit = defineEmits(["close"]);
const store = useSessionStore();

const form = ref({
  name: "",
  command: "codex",
  cwd: "",
});

const loading = ref(false);
const error = ref("");
const projects = ref([]), projectsLoading = ref(false), projectsError = ref('');
const needsProject = computed(() => store.platform === 'win32' && form.value.command === 'codex');
async function refreshProjects() {
  projectsLoading.value = true; projectsError.value = '';
  try {
    const response = await fetch(hubUrl('/api/sessions/projects'));
    if (!response.ok) throw new Error('项目列表读取失败');
    const data = await response.json(); projects.value = data.projects || [];
    if (data.error) projectsError.value = data.error;
    if (!projects.value.some(p => p.path === form.value.cwd)) {
      let previous; try { previous = localStorage.getItem('home-terminal.last-project'); } catch {}
      form.value.cwd = projects.value.find(p => p.path === previous)?.path || projects.value.find(p => p.active)?.path || projects.value[0]?.path || '';
    }
  } catch (e) { projectsError.value = e.message; projects.value = []; form.value.cwd = ''; }
  finally { projectsLoading.value = false; }
}
onMounted(refreshProjects);

const nameHint = computed(() => {
  return form.value.name ? form.value.name : `${form.value.command}-auto`;
});

async function handleSubmit() {
  if (loading.value) return;
  if (needsProject.value && !form.value.cwd) { error.value = '请先选择 Codex 项目目录'; return; }
  loading.value = true;
  error.value = "";
  try {
    await store.create({ ...form.value, cwd: needsProject.value ? form.value.cwd : undefined });
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
        <h3>Create New Session</h3>
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
            <option v-for="project in projects" :key="project.path" :value="project.path">{{ project.name }}{{ project.active ? '（Codex 当前项目）' : '' }}</option>
          </select>
          <span class="label-text project-path">{{ form.cwd }}</span>
          <span v-if="projectsError" role="alert">{{ projectsError }}</span>
          <span v-else-if="!projectsLoading && !projects.length" class="label-text">暂无可用项目，请先在本机 Codex 中打开项目。</span>
          <button type="button" class="btn" :disabled="projectsLoading" @click="refreshProjects">刷新项目列表</button>
        </label>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button
          class="btn btn-primary"
          @click="handleSubmit"
          :disabled="loading || (needsProject && (projectsLoading || !form.cwd))"
        >
          {{ loading ? "Creating..." : "Create Session" }}
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
  max-width: 400px;
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
