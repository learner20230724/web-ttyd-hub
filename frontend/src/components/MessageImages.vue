<script setup>
import { ref } from 'vue'
import { hubUrl } from '../utils/base.mjs'
defineProps({ images: Array, sessionName: String })
const emit = defineEmits(['loaded'])
const expanded = ref(null)
const url = (name, id) => hubUrl(`/api/sessions/${encodeURIComponent(name)}/images/${id}`)
</script>
<template>
  <div class="message-images">
    <button v-for="image in images" :key="image.id" type="button" class="image-preview" aria-label="放大图片" @click="expanded = image.id">
      <img :src="url(sessionName, image.id)" alt="会话图片" loading="lazy" @load="emit('loaded')">
    </button>
    <dialog :open="Boolean(expanded)" class="image-viewer" @click.self="expanded = null" @keydown.esc="expanded = null">
      <button type="button" class="close-image" @click="expanded = null">关闭图片 ×</button>
      <img v-if="expanded" :src="url(sessionName, expanded)" alt="放大的会话图片">
    </dialog>
  </div>
</template>
<style scoped>
.message-images { display:flex; gap:12px; flex-wrap:wrap; margin-top:8px; }
.image-preview { display:block; max-width:100%; padding:0; border:1px solid #40516b; border-radius:10px; overflow:hidden; background:#101827; cursor:zoom-in; }
.image-preview img { display:block; max-width:100%; max-height:420px; min-height:48px; object-fit:contain; }
.image-viewer[open] { position:fixed; inset:0; margin:0; width:100%; height:100%; max-width:none; max-height:none; box-sizing:border-box; z-index:100; background:#080d16f5; border:0; padding:64px 12px 20px; overflow:auto; }
.image-viewer img { display:block; max-width:100%; height:auto; margin:auto; touch-action:pan-x pan-y pinch-zoom; }
.close-image { position:fixed; top:max(12px, env(safe-area-inset-top)); right:16px; border:0; border-radius:8px; padding:10px 16px; color:white; background:#25364b; cursor:pointer; }
</style>
