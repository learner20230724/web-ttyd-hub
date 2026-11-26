<script setup>
import { ref } from 'vue'
import { draftKey } from '../utils/session-drafts.mjs'
const props = defineProps({ compact: Boolean, disabled: Boolean, busy: Boolean, session: Object })
const emit = defineEmits(['select'])
const picker = ref(null)
let selectionFor = ''
function open() {
  selectionFor = draftKey(props.session)
  picker.value.click()
}
function selected(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  if (files.length && selectionFor === draftKey(props.session)) emit('select', files)
}
</script>

<template>
  <span class="file-picker">
    <input ref="picker" type="file" multiple hidden @change="selected">
    <button type="button" aria-label="上传文件" :title="busy ? '文件上传中…' : '上传文件'" :class="{ compact }" :disabled="disabled || busy" @click="open">
      <span v-if="busy">…</span>
      <svg v-if="compact && !busy" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m8 13 7.6-7.6a3.3 3.3 0 0 1 4.7 4.7L10.1 20.3a5 5 0 0 1-7.1-7.1L13.2 3"/><path d="m6.4 14.6 8.8-8.8a1.4 1.4 0 0 1 2 2l-8.8 8.8"/></svg>
      <span v-if="!busy">上传文件</span>
    </button>
  </span>
</template>

<style scoped>
.file-picker { display:inline-flex; flex-shrink:0; }
button { min-height:36px; border:1px solid #40516b; border-radius:8px; background:#25364b; color:#e2e8f0; padding:6px 10px; cursor:pointer; }
button.compact { display:inline-flex; align-items:center; justify-content:center; gap:4px; font-size:13px; min-width:36px; padding:0; background:transparent; border:0; }
button:disabled { opacity:.55; }
</style>
