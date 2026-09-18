<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { ansiToRuns } from '../utils/ansi.mjs'
import { useSessionStore } from '../stores/sessions'
const store = useSessionStore()
const session = computed(() => store.sessions.find(s => s.name === store.current))
const content = ref({}), error = ref(''), draft = ref(''), sending = ref(false), more = ref(false)
const pane = ref(null), follow = ref(true)
const drafts = new Map()
const messages = computed(() => (content.value.messages || []).map(m => ({ ...m, html: DOMPurify.sanitize(marked.parse(m.text), { FORBID_TAGS: ['img'], FORBID_ATTR: ['style'] }) })))
const runs = computed(() => ansiToRuns(content.value.ansi || content.value.text || ''))
let controller, timer, disposed = false
function scrolled() { const p = pane.value; if (p) follow.value = p.scrollHeight - p.scrollTop - p.clientHeight < 70 }
async function bottom() { follow.value = true; await nextTick(); if (pane.value) pane.value.scrollTop = pane.value.scrollHeight }
async function refresh() {
  clearTimeout(timer)
  if (disposed) return
  const name = session.value?.name
  if (!name || session.value.status !== 'running' || document.hidden) { timer = setTimeout(refresh, 1200); return }
  controller?.abort(); const c = new AbortController(); controller = c
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}/mobile`, { signal: c.signal })
    const data = await res.json()
    delete data.capturedAt
    if (!res.ok) throw new Error(data.error)
    if (c.signal.aborted || session.value?.name !== name) return
    // Don't replace DOM when unchanged: preserve selection, copying and reading position.
    if (JSON.stringify(content.value) !== JSON.stringify(data)) {
      content.value = data
      if (follow.value && !window.getSelection()?.toString()) await bottom()
    }
    error.value = ''
  } catch (e) { if (!c.signal.aborted) error.value = e.message }
  finally { if (controller === c && !disposed) timer = setTimeout(refresh, 1200) }
}
watch(() => store.current, (name, previous) => {
  if (previous) drafts.set(previous, draft.value)
  draft.value = drafts.get(name) || ''; content.value = {}; error.value = ''; follow.value = true; more.value = false
  controller?.abort(); refresh()
}, { immediate: true })
async function send(key = 'Enter', withText = true) {
  if (sending.value || !session.value) return
  const name = session.value.name, text = withText ? draft.value : ''
  sending.value = true; error.value = ''
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, key }) })
    const data = await res.json(); if (!res.ok) throw new Error(data.error)
    if (withText) { drafts.delete(name); if (store.current === name && draft.value === text) draft.value = '' }
    if (store.current === name) { await bottom(); refresh() }
  } catch (e) { error.value = `未确认发送成功，请检查终端后重试：${e.message}` }
  finally { sending.value = false }
}
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); controller?.abort() })
</script>
<template>
  <section class="mobile-terminal">
    <template v-if="session">
      <div class="mobile-session-title">{{ session.displayName || session.name }}<span>{{ session.activity?.busy ? '正在回答…' : session.status === 'running' ? '已连接' : '已停止' }}</span></div>
      <div ref="pane" class="mobile-reading" @scroll.passive="scrolled">
        <template v-if="messages.length">
          <article v-for="message in messages" :key="message.id" :class="['message', message.role]">
            <div class="speaker">{{ message.role === 'user' ? '你' : 'Codex' }}</div>
            <div class="markdown" v-html="message.html"></div>
          </article>
        </template>
        <pre v-else class="mobile-output"><span v-for="(run, i) in runs" :key="i" :style="run.style">{{ run.text }}</span></pre>
      </div>
      <button v-if="!follow" class="latest" @click="bottom">↓ 回到最新</button>
      <p v-if="error" class="mobile-error" role="alert">{{ error }}</p>
      <form v-if="session.status === 'running'" class="composer" @submit.prevent="send()">
        <div v-if="more" class="keys"><button v-for="key in ['Escape', 'Up', 'Down', 'Tab', 'C-c']" :key="key" type="button" :disabled="sending" @click="send(key, false)">{{ {Escape:'Esc', Up:'↑', Down:'↓', Tab:'Tab', 'C-c':'中断'}[key] }}</button><button type="button" :disabled="sending || !draft" @click="send(null)">仅输入</button></div>
        <div class="compose-row"><button type="button" class="extra" :aria-expanded="more" aria-label="终端按键" @click="more = !more">＋</button>
          <textarea v-model="draft" aria-label="消息输入" placeholder="输入消息…" rows="2" enterkeyhint="enter"></textarea>
          <button class="send" :disabled="sending" type="submit">{{ sending ? '…' : draft ? '发送' : '回车' }}</button></div>
      </form>
    </template>
    <div v-else class="mobile-empty">从左上角选择会话，继续你的工作。</div>
  </section>
</template>
<style scoped>
.mobile-terminal { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; position:relative; background:#0e1420; color:#e5eaf2 }
.mobile-session-title { padding:10px 16px; font-size:14px; border-bottom:1px solid #263143; overflow-wrap:anywhere }
.mobile-session-title span { float:right; color:#91a0b7; font-size:12px; margin-left:8px }
.mobile-reading { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:16px; touch-action:pan-y; }
.message { margin:0 0 24px; line-height:1.75; font-size:16px; overflow-wrap:anywhere; user-select:text }
.message.user { background:#1c2a40; border-radius:14px; padding:12px 14px; }
.speaker { color:#7dd3fc; font-size:12px; font-weight:600; margin-bottom:8px }
.user .speaker { color:#c4b5fd }
.markdown :deep(p) { margin:0 0 12px; white-space:pre-wrap }
.markdown :deep(pre) { background:#060b13; padding:12px; border-radius:8px; overflow-x:auto; white-space:pre; font:13px/1.6 monospace; margin:12px 0 }
.markdown :deep(code) { color:#a5e7d4; font-family:monospace }
.markdown :deep(strong) { color:#f8d58b }
.markdown :deep(a) { color:#7dd3fc; text-decoration:underline }
.markdown :deep(ul), .markdown :deep(ol) { padding-left:24px; margin:10px 0 }
.markdown :deep(h1), .markdown :deep(h2), .markdown :deep(h3) { font-size:18px; margin:18px 0 10px }
.markdown :deep(table) { display:block; overflow-x:auto; border-collapse:collapse }
.markdown :deep(td), .markdown :deep(th) { padding:6px; border:1px solid #344259 }
.mobile-output { margin:0; font:14px/1.65 monospace; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text }
.composer { padding:10px 12px; border-top:1px solid #263143; background:#131c2a; }
.compose-row { display:flex; gap:8px; align-items:center }
textarea { flex:1; min-width:0; resize:none; max-height:160px; font:16px/1.5 sans-serif; background:#1d293b; color:#f1f5f9; border:1px solid #40516b; border-radius:12px; padding:10px; }
button { min-height:44px; border:0; border-radius:10px; padding:8px 12px; background:#25364b; color:#e2e8f0; font-size:14px }
.send { background:#2563eb; color:white; } button:disabled { opacity:.55 }
.extra { padding:8px; font-size:22px }
.keys { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px }
.latest { position:absolute; right:16px; bottom:110px; box-shadow:0 3px 15px #0008 }
.mobile-error { padding:8px 16px; color:#fda4af; font-size:13px }
.mobile-empty { margin:auto; padding:20px; color:#94a3b8 }
</style>
