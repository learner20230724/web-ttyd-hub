<script setup>
import { ref } from 'vue'
import { hubUrl } from '../utils/base.mjs'
const props = defineProps({ images: Array, sessionName: String, generation: String, compact: Boolean })
const emit = defineEmits(['loaded'])
const expanded = ref(null), viewer = ref(null)
const failures = ref({}), attempts = ref({})
function url(id) {
  const params = new URLSearchParams()
  if (props.generation) params.set('generation', props.generation)
  if (attempts.value[id]) params.set('retry', attempts.value[id])
  const query = params.toString()
  return hubUrl(`/api/sessions/${encodeURIComponent(props.sessionName)}/images/${encodeURIComponent(id)}${query ? '?' + query : ''}`)
}
function open(id) {
  if (failures.value[id]) {
    delete failures.value[id]
    attempts.value[id] = (attempts.value[id] || 0) + 1
    return
  }
  expanded.value = id
  viewer.value.showModal()
}
</script>
<template>
  <div class="message-images" :class="{ compact }" :role="compact ? 'group' : undefined">
    <span v-if="compact" class="image-label">回复图片</span>
    <button v-for="image in images" :key="image.id" type="button" class="image-preview"
      :aria-label="failures[image.id] ? '重新加载图片' : '放大图片'" @click="open(image.id)">
      <span v-if="failures[image.id]">重试图片</span>
      <img v-else :src="url(image.id)" alt="会话图片" loading="lazy" @error="failures[image.id] = true" @load="emit('loaded')">
    </button>
    <dialog ref="viewer" class="image-viewer" aria-label="回复图片" @close="expanded = null" @click.self="viewer.close()">
      <button type="button" class="close-image" @click="viewer.close()">关闭图片 ×</button>
      <img v-if="expanded" :src="url(expanded)" alt="放大的会话图片">
    </dialog>
  </div>
</template>
<style scoped>
.message-images { display:flex; gap:12px; flex-wrap:wrap; margin-top:8px; }
.image-preview { display:block; max-width:100%; padding:0; border:1px solid #40516b; border-radius:10px; overflow:hidden; background:#101827; cursor:zoom-in; }
.image-preview img { display:block; max-width:100%; max-height:420px; min-height:48px; object-fit:contain; }
.message-images.compact { flex:1 1 0; min-width:0; flex-wrap:nowrap; align-items:center; gap:6px; margin:0; overflow-x:auto; }
.image-label { flex:none; color:#aab8ca; font-size:12px; }
.compact .image-preview { flex:none; }
.compact .image-preview img { max-width:100px; height:54px; min-height:0; }
.image-preview > span { display:block; color:#ced8e6; padding:6px; }
.image-viewer[open] { position:fixed; inset:0; margin:0; width:100%; height:100%; max-width:none; max-height:none; box-sizing:border-box; z-index:100; background:#080d16f5; border:0; padding:64px 12px 20px; overflow:auto; }
.image-viewer img { display:block; max-width:100%; height:auto; margin:auto; touch-action:pan-x pan-y pinch-zoom; }
.close-image { position:fixed; top:max(12px, env(safe-area-inset-top)); right:16px; border:0; border-radius:8px; padding:10px 16px; color:white; background:#25364b; cursor:pointer; }
</style>
