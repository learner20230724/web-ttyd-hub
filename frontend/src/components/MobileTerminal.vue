<script setup>
import { ref, shallowRef, markRaw, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { contentKey, peekContent, loadContent, fetchContent } from '../utils/session-content.mjs'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { terminalSegments, tableMarkdown } from '../utils/terminal-tables.mjs'
import { ansiToRuns } from '../utils/ansi.mjs'
import { useSessionStore } from '../stores/sessions'
const props = defineProps({ navigationOpen: Boolean, showExecution: Boolean, fontSize: { type: Number, default: 16 } })
const store = useSessionStore()
const session = computed(() => store.sessions.find(s => s.name === store.current))
const content = shallowRef({}), error = ref(''), draft = ref(''), sending = ref(false), more = ref(false)
const pane = ref(null), follow = ref(true)
const drafts = new Map()
const pendingBySession = ref({})
const transcriptIds = new Map()
const pendingMessages = computed(() => pendingBySession.value[store.current] || [])
function reconcilePending(name, messages) {
  if (!messages) return
  const pending = pendingBySession.value[name] || []
  const matched = new Set()
  pendingBySession.value[name] = pending.filter(item => {
    const message = messages.find(m => m.role === 'user' && !matched.has(m.id) && !item.before.includes(m.id) && m.text.trim() === item.text.trim())
    if (message) { matched.add(message.id); return false }
    item.before = [...new Set([...item.before, ...messages.map(m => m.id)])]
    return true
  })
  transcriptIds.set(name, messages.map(m => m.id))
}
function dismissPending(id) { pendingBySession.value[store.current] = pendingMessages.value.filter(item => item.id !== id) }
const renderedMessages = new Map(), renderedOutput = new WeakMap()
const messages = computed(() => (content.value.messages || []).map(m => {
  const key = `${m.role}:${m.id}`
  const old = renderedMessages.get(key)
  if (old?.text === m.text) return old
  const rendered = markRaw({ ...m, html: DOMPurify.sanitize(marked.parse(tableMarkdown(m.text)), { FORBID_TAGS: ['img'], FORBID_ATTR: ['style'] }) })
  renderedMessages.set(key, rendered)
  if (renderedMessages.size > 1200) renderedMessages.delete(renderedMessages.keys().next().value)
  return rendered
}))
const outputSegments = computed(() => {
  const data = content.value
  if (!renderedOutput.has(data)) renderedOutput.set(data, markRaw(terminalSegments(data.ansi || data.text || '').map(s => s.type === 'text' ? { ...s, runs: ansiToRuns(s.text) } : s)))
  return renderedOutput.get(data)
})
const positions = new Map()
let timer, disposed = false, epoch = 0, visibleKey = null, switching = false
function scrolled() {
  const p = pane.value
  if (!p || switching) return
  follow.value = p.scrollHeight - p.scrollTop - p.clientHeight < 70
  if (visibleKey) positions.set(visibleKey, { top:p.scrollTop, follow:follow.value })
}
async function bottom() { follow.value = true; await nextTick(); if (pane.value) pane.value.scrollTop = pane.value.scrollHeight }
async function display(entry, first = false) {
  if (!entry || entry.data === content.value) return
  content.value = markRaw(entry.data)
  const key = visibleKey
  await nextTick()
  if (key !== visibleKey || !pane.value) return
  const position = positions.get(key)
  if (first && position && !position.follow) pane.value.scrollTop = position.top
  else if (follow.value && !window.getSelection()?.toString()) pane.value.scrollTop = pane.value.scrollHeight
}
async function refresh(token = epoch) {
  if (disposed || token !== epoch) return
  clearTimeout(timer)
  const selected = session.value, view = props.showExecution ? 'full' : 'answer'
  if (!selected || document.hidden) { timer = setTimeout(() => refresh(token), 1200); return }
  try {
    const entry = await fetchContent(selected, view)
    if (disposed || token !== epoch) return
    if (view === 'answer') reconcilePending(selected.name, entry.data.messages)
    await display(entry)
    error.value = ''
    if (view === 'full' && pendingMessages.value.some(item => item.codex)) {
      void fetchContent(selected, 'answer').then(answer => { if (token === epoch) reconcilePending(selected.name, answer.data.messages) }).catch(() => {})
    }
  } catch (e) {
    if (token === epoch) error.value = Object.keys(content.value).length ? '正在显示缓存，暂时无法更新。' : e.message
  } finally { if (!disposed && token === epoch) { clearTimeout(timer); timer = setTimeout(() => refresh(token), 1200) } }
}
watch([() => store.current, () => props.showExecution], async ([name, full], previous) => {
  const previousName = previous?.[0]
  if (visibleKey && pane.value) positions.set(visibleKey, { top:pane.value.scrollTop, follow:follow.value })
  if (previousName && name !== previousName) drafts.set(previousName, draft.value)
  if (name !== previousName) { draft.value = drafts.get(name) || ''; more.value = false }
  const token = ++epoch, selected = session.value
  clearTimeout(timer); error.value = ''; switching = true
  const view = full ? 'full' : 'answer'
  visibleKey = selected ? contentKey(selected, view) : null
  follow.value = positions.get(visibleKey)?.follow ?? true
  const cached = selected ? peekContent(selected, view) : null
  content.value = {} // A different session must never display the previous session's text.
  if (cached) await display(cached, true)
  if (!selected) { switching = false; return }
  // Start current view and the other view independently; never wait for one to fetch the other.
  void refresh(token)
  const other = full ? 'answer' : 'full'
  void fetchContent(selected, other).then(entry => {
    if (token === epoch && other === 'answer') reconcilePending(name, entry.data.messages)
  }).catch(() => {})
  if (!cached) {
    const stored = await loadContent(selected, view)
    if (token === epoch && !Object.keys(content.value).length) await display(stored, true)
  }
  if (token === epoch) { await nextTick(); switching = false }
}, { immediate: true })
watch(() => props.fontSize, async () => { if (follow.value) await bottom() })
async function send(key = 'Enter', withText = true) {
  if (sending.value || !session.value) return
  const name = session.value.name, text = withText ? draft.value : ''
  sending.value = true; error.value = ''
  const pending = text && key === 'Enter' ? { id: `${Date.now()}-${Math.random()}`, text, codex: session.value.activity?.available === true, status: 'sending', before: transcriptIds.get(name) || [] } : null
  if (pending) {
    pendingBySession.value[name] = [...(pendingBySession.value[name] || []), pending]
    await bottom()
  }
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, key }) })
    const data = await res.json(); if (!res.ok) throw new Error(data.error)
    if (pending) {
      const item = pendingBySession.value[name]?.find(item => item.id === pending.id)
      if (item) item.status = 'delivered'
    }
    if (withText) { drafts.delete(name); if (store.current === name && draft.value === text) draft.value = '' }
    if (store.current === name) { await bottom(); refresh() }
  } catch (e) {
    const item = pending && pendingBySession.value[name]?.find(item => item.id === pending.id)
    if (item) item.status = 'uncertain'
    error.value = `未确认发送成功，请检查终端后重试：${e.message}`
  }
  finally { sending.value = false }
}
onBeforeUnmount(() => { disposed = true; epoch++; clearTimeout(timer) })
</script>
<template>
  <section class="mobile-terminal" :style="{ '--reading-size': `${fontSize}px` }">
    <div v-if="navigationOpen" id="mobile-navigation" class="mobile-navigation" role="group" aria-label="终端方向键、回车和组合键">
      <button v-for="key in ['Up', 'Down', 'Left', 'Right', 'Enter', 'S-Left']" :key="key" type="button" :class="{ 'wide-key': key === 'Enter' || key === 'S-Left' }"
        :aria-label="{Up:'方向键上', Down:'方向键下', Left:'方向键左', Right:'方向键右', Enter:'终端回车', 'S-Left':'Shift 加左方向键'}[key]"
        :disabled="sending || session?.status !== 'running'" @click="send(key, false)">{{ {Up:'↑', Down:'↓', Left:'←', Right:'→', Enter:'↵ 回车', 'S-Left':'Shift+←'}[key] }}</button>
    </div>
    <template v-if="session">
      <div class="mobile-session-title">{{ session.displayName || session.name }}<span>{{ session.activity?.busy ? '正在回答…' : session.status === 'running' ? '已连接' : '已停止' }}</span></div>
      <div ref="pane" class="mobile-reading" @scroll.passive="scrolled">
        <template v-if="!showExecution && messages.length">
          <article v-for="message in messages" :key="message.id" :class="['message', message.role]">
            <div class="speaker">{{ message.role === 'user' ? '你' : 'Codex' }}</div>
            <div class="markdown" v-html="message.html"></div>
          </article>
        </template>
        <div v-else class="terminal-segments">
          <template v-for="(segment, index) in outputSegments" :key="index">
            <div v-if="segment.type === 'table'" class="terminal-table" role="region" aria-label="终端表格，可左右滑动" tabindex="0">
              <table><tbody><tr v-for="(row, r) in segment.rows" :key="r"><td v-for="(cell, c) in row" :key="c">{{ cell }}</td></tr></tbody></table>
            </div>
            <pre v-else class="mobile-output"><span v-for="(run, i) in segment.runs" :key="i" :style="run.style">{{ run.text }}</span></pre>
          </template>
        </div>
        <article v-for="item in pendingMessages" :key="item.id" class="pending-message" :class="item.status" role="status">
          <div class="pending-text">{{ item.text }}</div>
          <div class="pending-status">
            <span>{{ item.status === 'sending' ? '发送中…' : item.status === 'delivered' ? (item.codex ? '已送达终端 · 等待 Codex 接收，通常在下一次工具调用后' : '已发送到终端') : '发送结果未确认，请查看全文模式后再决定是否重发' }}</span>
            <button v-if="item.status !== 'sending'" type="button" aria-label="关闭发送提示" @click="dismissPending(item.id)">×</button>
          </div>
        </article>
      </div>
      <button v-if="!follow" class="latest" @click="bottom">↓ 回到最新</button>
      <p v-if="error" class="mobile-error" role="alert">{{ error }}</p>
      <form v-if="session.status === 'running'" class="composer" @submit.prevent="send()">
        <div v-if="more" class="keys"><button v-for="key in ['Escape', 'Tab', 'C-c']" :key="key" type="button" :disabled="sending" @click="send(key, false)">{{ {Escape:'Esc', Up:'↑', Down:'↓', Left:'←', Right:'→', Tab:'Tab', 'C-c':'中断'}[key] }}</button><button type="button" :disabled="sending || !draft" @click="send(null)">仅输入</button></div>
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
.mobile-navigation { display:flex; gap:6px; padding:8px 12px; border-bottom:1px solid #263143; flex-shrink:0; background:#131c2a; }
.mobile-navigation button { flex:1; min-width:0; padding:6px; font-size:20px; }
.mobile-navigation button.wide-key { flex:1.6; font-size:13px; white-space:nowrap; }
.mobile-session-title { padding:10px 16px; font-size:14px; border-bottom:1px solid #263143; overflow-wrap:anywhere }
.mobile-session-title span { float:right; color:#91a0b7; font-size:12px; margin-left:8px }
.mobile-reading { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:16px; touch-action:pan-x pan-y; }
.message { margin:0 0 24px; line-height:1.75; font-size:var(--reading-size); overflow-wrap:anywhere; user-select:text }
.pending-message { margin:16px 0; padding:12px 14px; border:1px dashed #52729b; border-radius:14px; background:#18273d; }
.pending-text { font-size:var(--reading-size); white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.6; }
.pending-status { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; font-size:12px; color:#93c5fd; }
.pending-status button { min-height:32px; min-width:32px; padding:0; background:transparent; font-size:20px; }
.pending-message.uncertain { border-color:#fda4af; }.uncertain .pending-status { color:#fda4af; }
.message.user { background:#1c2a40; border-radius:14px; padding:12px 14px; }
.speaker { color:#7dd3fc; font-size:12px; font-weight:600; margin-bottom:8px }
.user .speaker { color:#c4b5fd }
.markdown :deep(p) { margin:0 0 12px; white-space:pre-wrap }
.markdown :deep(pre) { background:#060b13; padding:12px; border-radius:8px; overflow-x:auto; white-space:pre; font:calc(var(--reading-size) * .85)/1.6 monospace; margin:12px 0 }
.markdown :deep(code) { color:#a5e7d4; font-family:monospace }
.markdown :deep(strong) { color:#f8d58b }
.markdown :deep(a) { color:#7dd3fc; text-decoration:underline }
.markdown :deep(ul), .markdown :deep(ol) { padding-left:24px; margin:10px 0 }
.markdown :deep(h1), .markdown :deep(h2), .markdown :deep(h3) { font-size:calc(var(--reading-size) * 1.125); margin:18px 0 10px }
.markdown :deep(table) { display:block; max-width:100%; overflow-x:auto; border-collapse:collapse; touch-action:pan-x pan-y; margin:12px 0; }
.markdown :deep(td), .markdown :deep(th) { padding:8px 10px; border:1px solid #344259; min-width:5em; white-space:nowrap }
.terminal-table { max-width:100%; overflow-x:auto; margin:12px 0; touch-action:pan-x pan-y; font-size:var(--reading-size); }
.terminal-table table { border-collapse:collapse; min-width:100%; }
.terminal-table td { padding:8px 10px; border:1px solid #344259; white-space:nowrap; line-height:1.6; }
.terminal-table tr:first-child { background:#1c2a40; color:#7dd3fc; }
.mobile-output { margin:0; font:var(--reading-size)/1.65 monospace; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text }
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
