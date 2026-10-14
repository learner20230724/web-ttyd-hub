<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { hubUrl } from '../utils/base.mjs'
const emit = defineEmits(['close'])
const dialog = ref(null), data = ref(null), loading = ref(false), error = ref('')
let controller, timer
function time(value) { return value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '暂未提供' }
function resetLabel(value) { return value && Date.parse(value) <= Date.now() ? '已到重置时间，请刷新确认' : `重置时间：${time(value)}` }
async function refresh(force = false) {
  if (loading.value) return
  loading.value = true; error.value = ''; controller = new AbortController()
  timer = setTimeout(() => controller.abort(), 45000)
  try {
    const response = await fetch(hubUrl(`/api/sessions/codex-usage${force ? '?refresh=1' : ''}`), { signal: controller.signal, cache: 'no-store' })
    const result = await response.json(); if (!response.ok) throw Error(result.error || '暂时无法读取额度')
    data.value = result
  } catch (e) { error.value = e.name === 'AbortError' ? '读取超时，请稍后刷新' : e.message }
  finally { clearTimeout(timer); loading.value = false }
}
onMounted(() => { dialog.value.showModal(); refresh() })
onBeforeUnmount(() => { clearTimeout(timer); controller?.abort(); dialog.value?.close() })
</script>
<template>
  <dialog ref="dialog" class="usage-dialog" aria-labelledby="usage-title" @cancel.prevent="emit('close')" @click="event => { if (event.target === dialog) emit('close') }">
    <header><h2 id="usage-title">账号剩余额度</h2><button type="button" aria-label="关闭账号额度" @click="emit('close')">×</button></header>
    <p class="intro">服务器上 Codex 当前登录账号的额度，所有会话共享。</p>
    <p v-if="loading && !data" class="notice" role="status">正在读取账号额度…</p>
    <p v-if="error || data?.message" class="notice" :class="{ warning: error || data?.stale }" role="status">{{ error || data.message }}</p>
    <div class="usage-windows" :class="{ stale: error || data?.stale }">
      <article v-for="window in data?.windows || []" :key="window.id" class="usage-window">
        <div class="window-label"><span>{{ window.name }} · {{ window.period }}</span><strong>{{ Math.round(window.remainingPercent * 10) / 10 }}<small>% 剩余</small></strong></div>
        <progress :value="window.remainingPercent" max="100" :aria-label="`${window.name} ${window.period}剩余 ${window.remainingPercent}%`" :class="{ low: window.remainingPercent <= 10 }"></progress>
        <p>{{ resetLabel(window.resetsAt) }}</p>
      </article>
    </div>
    <footer><p>{{ data?.fetchedAt ? `${data.stale || error ? '上次成功读取' : '更新时间'}：${time(data.fetchedAt)}` : '以 Codex 账号实际返回的额度为准' }}</p>
      <button type="button" class="refresh" :disabled="loading" @click="refresh(true)">{{ loading ? '读取中…' : '刷新额度' }}</button></footer>
  </dialog>
</template>
<style scoped>
.usage-dialog { width:min(460px, calc(100vw - 24px)); max-height:calc(100dvh - 32px); margin:auto; padding:20px; border:1px solid #344259; border-radius:18px; background:#111b2b; color:#e5eaf2; overflow:auto; box-sizing:border-box; }
.usage-dialog::backdrop { background:#0009; }
header, .window-label, footer { display:flex; align-items:center; justify-content:space-between; gap:12px; }
h2 { font-size:18px; margin:0; } button { min-width:44px; min-height:44px; border:0; border-radius:10px; padding:8px 12px; color:#dce6f3; background:#25364b; cursor:pointer; }
header button { font-size:24px; background:transparent; }
.intro, .notice, footer p, .usage-window p { font-size:13px; line-height:1.6; color:#acbad0; margin:12px 0; }
.notice { padding:12px; border-radius:10px; background:#1e2c41; }.warning { color:#fde68a; }
.usage-window { padding:16px 0; border-bottom:1px solid #2a384e; }.window-label { align-items:flex-end; flex-wrap:wrap; font-size:14px; }.window-label strong { font-size:26px; color:#7dd3fc; font-variant-numeric:tabular-nums; }small { font-size:12px; margin-left:4px; font-weight:normal; }
progress { display:block; width:100%; height:8px; border:0; border-radius:8px; overflow:hidden; margin-top:14px; background:#28364c; }progress::-webkit-progress-bar { background:#28364c; }progress::-webkit-progress-value { background:#38bdf8; border-radius:8px; }progress::-moz-progress-bar { background:#38bdf8; }.low::-webkit-progress-value { background:#fbbf24; }.low::-moz-progress-bar { background:#fbbf24; }
.stale { opacity:.6; }.usage-window p { margin-bottom:0; }footer { margin-top:16px; flex-wrap:wrap; }footer p { flex:1; min-width:150px; margin:0; }.refresh { background:#2563eb; color:white; }button:disabled { opacity:.5; cursor:default; }
</style>
