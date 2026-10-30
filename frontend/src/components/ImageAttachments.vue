<script setup>
import { ref, onBeforeUnmount } from 'vue'
import { hubUrl } from '../utils/base.mjs'
const props = defineProps({ session: Object, modelValue: { type: Array, default: () => [] }, disabled: Boolean, compact: Boolean, previewTarget: String })
const emit = defineEmits(['update:modelValue', 'busy', 'error'])
const picker = ref(null), uploading = ref(false)
let disposed = false
const request = new AbortController()
onBeforeUnmount(() => { disposed = true; request.abort() })
async function addFiles(files) {
  if (props.disabled || uploading.value) return
  const selected = Array.from(files || []).filter(f => f.type.startsWith('image/'))
  if (!selected.length) return
  if (selected.length + props.modelValue.length > 8) { emit('error', '一次最多添加 8 张图片'); return }
  const session = props.session, items = [...props.modelValue]
  uploading.value = true; emit('busy', true); emit('error', '')
  try {
    for (const file of selected) {
      if (file.size > 20 * 1024 * 1024) throw new Error('每张图片最大 20 MB')
      const res = await fetch(hubUrl(`/api/sessions/${encodeURIComponent(session.name)}/images`), {
        method: 'POST', headers: { 'Content-Type': file.type, 'X-TTYD-Generation': session.createdAt || '' }, body: file, signal: request.signal,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '图片上传失败')
      if (disposed || props.session.name !== session.name || props.session.createdAt !== session.createdAt) return
      if (!items.some(item => item.id === data.id)) items.push({ id: data.id, name: file.name || '截图' }); emit('update:modelValue', [...items])
    }
  } catch (error) { if (!disposed) emit('error', error.message) }
  finally { uploading.value = false; if (!disposed) emit('busy', false); if (picker.value) picker.value.value = '' }
}
function paste(event) {
  const files = Array.from(event.clipboardData?.files || []).filter(f => f.type.startsWith('image/'))
  if (!files.length) return false
  event.preventDefault(); event.stopImmediatePropagation(); void addFiles(files); return true
}
defineExpose({ addFiles, paste })
</script>
<template>
  <div class="image-attachments">
    <input ref="picker" class="image-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple @change="addFiles($event.target.files)">
    <button type="button" class="image-pick" :class="{ compact }" aria-label="添加图片" :title="uploading ? '上传中…' : '添加图片'" :disabled="disabled || uploading" @click="picker.click()"><span v-if="compact && uploading" aria-hidden="true">…</span><svg v-else-if="compact" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 6"/></svg><span v-else>{{ uploading ? '上传中…' : '添加图片' }}</span></button>
    <Teleport :to="previewTarget || 'body'" :disabled="!previewTarget" defer>
    <div v-for="(item, index) in modelValue" :key="`${item.id}:${index}`" class="attachment">
      <img :src="hubUrl(`/api/sessions/${encodeURIComponent(session.name)}/images/${item.id}`)" :alt="item.name">
      <button type="button" :disabled="disabled || uploading" :aria-label="`移除图片 ${item.name}`" @click="emit('update:modelValue', modelValue.filter((_, i) => i !== index))">×</button>
    </div>
    </Teleport>
  </div>
</template>
<style scoped>
.image-attachments { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:8px; }
.image-file-input { display:none; }
button { min-height:36px; border:1px solid #40516b; border-radius:8px; background:#25364b; color:#e2e8f0; padding:6px 10px; cursor:pointer; }
button:disabled { opacity:.55; cursor:default; }
.image-pick.compact { min-height:36px; min-width:36px; font-size:23px; padding:0 6px; background:transparent; border:0; }
.attachment { display:inline-block; margin:0 8px 8px 0; position:relative; width:64px; height:56px; }
.attachment img { width:100%; height:100%; object-fit:cover; border-radius:6px; }
.attachment button { position:absolute; top:-5px; right:-5px; min-height:24px; width:24px; padding:0; border-radius:50%; background:#131c2a; }
</style>
