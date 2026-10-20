<script setup>
import { hubUrl } from '../utils/base.mjs'

import { ref, shallowRef, markRaw, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { contentKey, peekContent, loadContent, fetchContent } from '../utils/session-content.mjs'
import { inputKind, receiptCandidates, reconcileInputs } from '../utils/input-receipts.mjs'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { terminalSegments, tableMarkdown } from '../utils/terminal-tables.mjs'
import { ansiToRuns } from '../utils/ansi.mjs'
import { useSessionStore } from '../stores/sessions'
import ActivityBadge from './ActivityBadge.vue'
import CodexQuestions from './CodexQuestions.vue'
const emit = defineEmits(['show-execution'])
const props = defineProps({ navigationOpen: Boolean, showExecution: Boolean, readingVisible: { type: Boolean, default: true }, fontSize: { type: Number, default: 16 } })
const store = useSessionStore()
const session = computed(() => store.sessions.find(s => s.name === store.current))
const status = computed(() => session.value ? store.activityStatus(session.value) : null)
const now = ref(Date.now())
let lastHidden = document.hidden
const elapsedTimer = setInterval(() => {
  now.value = Date.now()
  // Some WebViews change visibility after the initial read was skipped without
  // delivering visibilitychange. Reuse the clock to recover that missed read.
  if (document.hidden !== lastHidden) {
    // Replace a list request suspended during startup too; otherwise cached
    // metadata can keep the reader gated until that old request times out.
    if (!document.hidden) void store.fetchSessions().catch(() => {})
    resumeReading()
  }
}, 1000)
const elapsed = computed(() => {
  if (!session.value?.activity?.busy || store.connectionIssue) return ''
  const start = Date.parse(session.value.activity.startedAt)
  if (!Number.isFinite(start)) return ''
  const seconds = Math.max(0, Math.floor((now.value - start) / 1000))
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`
})
const content = shallowRef({}), error = ref(''), draft = ref(''), sending = ref(false), more = ref(false)
const answerStartedAt = ref(Date.now()), structuredAnswers = new Map()
const codexAnswer = computed(() => !props.showExecution && (session.value?.shell === 'codex' || session.value?.activity?.detected))
const answerUnavailable = computed(() => codexAnswer.value && !Array.isArray(content.value.messages))
const answerPlaceholder = computed(() => !answerUnavailable.value ? '此会话还没有回答。' : store.cachedSnapshot
  ? '此视图暂无本地缓存，联网后自动加载。' :
  error.value || now.value - answerStartedAt.value >= 10000 ? '暂时无法读取回答，正在自动重试。' : '正在读取回答…')
const questionPending = ref(false), questionSupport = ref(null)
const pane = ref(null), composerInput = ref(null), follow = ref(true)
const drafts = new Map()
const pendingBySession = ref({})
const inputNotices = ref({})
const inputErrors = ref({})
let inputRequest = null
const transcriptIds = new Map()
let inputGenerations = new Map()
watch(() => store.sessions.map(s => [s.name, s.createdAt || '']), entries => {
  const next = new Map(entries)
  for (const [name, generation] of inputGenerations) {
    if (next.get(name) === generation) continue
    drafts.delete(name); transcriptIds.delete(name)
    delete pendingBySession.value[name]; delete inputNotices.value[name]; delete inputErrors.value[name]
    // The selection watcher runs after this list update. Clear before it can
    // save the removed terminal's visible draft under a reused name.
    if (store.current === name) draft.value = ''
  }
  inputGenerations = next
}, { immediate: true, flush: 'sync' })
const pendingMessages = computed(() => pendingBySession.value[store.current] || [])
const inputError = computed(() => inputErrors.value[store.current] || '')
const inputNotice = computed(() => {
  const notice = inputNotices.value[store.current]
  return notice?.expiresAt > now.value ? notice.text : ''
})
function reconcilePending(name, data) {
  pendingBySession.value[name] = reconcileInputs(pendingBySession.value[name] || [], data)
  transcriptIds.set(name, receiptCandidates(data).map(m => m.id))
}
function dismissPending(id) { pendingBySession.value[store.current] = pendingMessages.value.filter(item => item.id !== id) }
const renderedMessages = new Map(), renderedOutput = new WeakMap()
const messages = computed(() => (content.value.messages || (codexAnswer.value && session.value
  ? structuredAnswers.get(contentKey(session.value, 'answer'))?.messages : null) || []).map(m => {
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
let timer, disposed = false, epoch = 0, refreshSequence = 0, visibleKey = null, switching = false, quickRefreshUntil = 0
// Selection and a completion notification are not proof that the reply was seen.
// The content snapshot carries the completion it actually includes.
const releaseReadGuard = store.setReadGuard(selected => props.readingVisible && follow.value &&
  (!codexAnswer.value || Array.isArray(content.value.messages)) &&
  visibleKey === contentKey(selected, props.showExecution ? 'full' : 'answer') &&
  content.value.completed === selected.activity?.completed)
watch(() => props.readingVisible, () => store.markRead(), { flush: 'post' })
function scrolled() {
  const p = pane.value
  if (!p || switching) return
  follow.value = p.scrollHeight - p.scrollTop - p.clientHeight < 70
  if (visibleKey) positions.set(visibleKey, { top:p.scrollTop, follow:follow.value })
  store.markRead()
}
async function bottom() { follow.value = true; await nextTick(); if (pane.value) pane.value.scrollTop = pane.value.scrollHeight; store.markRead() }
async function display(entry, first = false) {
  if (!entry || entry.key !== visibleKey || entry.data === content.value) return
  if (Array.isArray(entry.data.messages)) {
    structuredAnswers.delete(entry.key); structuredAnswers.set(entry.key, entry.data)
    if (structuredAnswers.size > 32) structuredAnswers.delete(structuredAnswers.keys().next().value)
  }
  content.value = markRaw(entry.data)
  const key = visibleKey
  await nextTick()
  if (key !== visibleKey || !pane.value) return
  const position = positions.get(key)
  if (first && position && !position.follow) pane.value.scrollTop = position.top
  else if (follow.value && !window.getSelection()?.toString()) pane.value.scrollTop = pane.value.scrollHeight
  store.markRead()
}
function refreshDelay() {
  const activity = session.value?.activity || {}
  return activity.busy || activity.available === false || activity.phase === 'unknown' || answerUnavailable.value ||
    pendingMessages.value.length || sending.value || questionPending.value || Date.now() < quickRefreshUntil ? 1200 : 15000
}
async function refresh(token = epoch, fresh = false) {
  if (disposed || token !== epoch) return
  clearTimeout(timer)
  const selected = session.value, view = props.showExecution ? 'full' : 'answer'
  // A cached name may now belong to a replacement session on the server. Keep
  // disk readable, but wait for the authoritative list before requesting data.
  if (!selected || document.hidden || store.cachedSnapshot) return
  const sequence = ++refreshSequence
  const current = () => !disposed && token === epoch && sequence === refreshSequence
  try {
    const entry = await fetchContent(selected, view, { fresh })
    if (!current()) return
    if (view === 'answer') reconcilePending(selected.name, entry.data)
    await display(entry)
    error.value = ''
    if (view === 'full' && pendingMessages.value.length) {
      void fetchContent(selected, 'answer').then(answer => { if (token === epoch) reconcilePending(selected.name, answer.data) }).catch(() => {})
    }
  } catch (e) {
    if (current()) error.value = Object.keys(content.value).length ? '正在显示缓存，暂时无法更新。' : e.message
  } finally { if (current() && !document.hidden && !store.cachedSnapshot) { clearTimeout(timer); timer = setTimeout(() => refresh(token), refreshDelay()) } }
}
function resumeReading() {
  lastHidden = document.hidden
  if (!lastHidden) void refresh(epoch, true)
  else clearTimeout(timer)
}
function restoredPage(event) { if (event.persisted) resumeReading() }
document.addEventListener('visibilitychange', resumeReading)
window.addEventListener('online', resumeReading)
window.addEventListener('focus', resumeReading)
window.addEventListener('pageshow', restoredPage)
watch(() => [store.current, session.value?.activity?.phase, session.value?.activity?.busy,
  session.value?.activity?.completed, session.value?.activity?.available], (value, previous) => {
  if (value[0] === previous?.[0] && value.slice(1).some((item, index) => item !== previous[index + 1])) void refresh(epoch, true)
})
watch([() => store.current, () => props.showExecution, () => session.value?.createdAt, () => store.cachedSnapshot], async ([name, full], previous) => {
  const previousName = previous?.[0]
  if (visibleKey && pane.value) positions.set(visibleKey, { top:pane.value.scrollTop, follow:follow.value })
  if (previousName && name !== previousName) drafts.set(previousName, draft.value)
  if (name !== previousName) { draft.value = drafts.get(name) || ''; more.value = false }
  const token = ++epoch, selected = session.value
  clearTimeout(timer); error.value = ''; answerStartedAt.value = Date.now(); switching = true
  const view = full ? 'full' : 'answer'
  visibleKey = selected ? contentKey(selected, view) : null
  follow.value = positions.get(visibleKey)?.follow ?? true
  const cached = selected ? peekContent(selected, view) : null
  content.value = {} // A different session must never display the previous session's text.
  if (cached) await display(cached, true)
  if (disposed || token !== epoch) return
  if (!selected) { switching = false; return }
  // Disk reads run independently of the network, so unavailable browser storage
  // cannot hold up a fresh response. The unseen view only warms from local disk;
  // downloading full terminal logs waits until the user actually opens them.
  if (!cached) void loadContent(selected, view).then(stored => {
    if (token === epoch && !Object.keys(content.value).length) return display(stored, true)
  })
  const other = full ? 'answer' : 'full'
  if (!peekContent(selected, other)) void loadContent(selected, other).then(entry => {
    if (entry && token === epoch && other === 'answer') reconcilePending(name, entry.data)
  }).catch(() => {})
  if (!store.cachedSnapshot) void refresh(token, true)
  if (token === epoch) { await nextTick(); switching = false }
}, { immediate: true })
watch(() => props.fontSize, async () => { if (follow.value) await bottom() })
async function send(key = 'Enter', withText = true) {
  if (sending.value || !session.value || store.cachedSnapshot) return
  // Vue postpones v-model updates during IME composition; send the visible text.
  const name = session.value.name, text = withText ? (composerInput.value?.value ?? draft.value) : ''
  const generation = session.value.createdAt || ''
  const sameSession = () => inputGenerations.get(name) === generation
  const kind = inputKind(text, session.value)
  if (withText) draft.value = text
  sending.value = true; error.value = ''
  quickRefreshUntil = Date.now() + 10000
  delete inputNotices.value[name]
  delete inputErrors.value[name]
  const pending = text && key === 'Enter' && kind === 'prompt' ? { id: `${Date.now()}-${Math.random()}`, text, codex: true, status: 'sending', before: transcriptIds.get(name) || [] } : null
  if (pending) {
    pendingBySession.value[name] = [...(pendingBySession.value[name] || []), pending]
    await bottom()
  }
  if (disposed || !sameSession()) { sending.value = false; return }
  if (text && kind === 'command') emit('show-execution', true)
  const request = new AbortController()
  inputRequest = request
  let timedOut = false
  const confirmationTimeout = setTimeout(() => { timedOut = true; request.abort() }, 10000)
  try {
    const res = await fetch(hubUrl(`/api/sessions/${encodeURIComponent(name)}/input`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, key }), signal: request.signal })
    const data = await res.json(); if (!res.ok) throw new Error(data.error)
    if (disposed || !sameSession()) return
    if (pending) {
      const item = pendingBySession.value[name]?.find(item => item.id === pending.id)
      if (item) item.status = 'delivered'
    } else if (text) inputNotices.value[name] = { text: key ? '已发送到终端' : '已输入终端，尚未按回车', expiresAt: Date.now() + 4000 }
    if (withText) {
      drafts.delete(name)
      if (store.current === name && draft.value === text) {
        draft.value = ''
        // Vue intentionally skips DOM writes during composition. Clear only
        // the submitted value so a later compositionend cannot restore it.
        if (composerInput.value?.value === text) composerInput.value.value = ''
      }
    }
    if (store.current === name) { await bottom(); refresh() }
  } catch (e) {
    if (disposed || !sameSession()) return
    const item = pending && pendingBySession.value[name]?.find(item => item.id === pending.id)
    const message = timedOut
      ? '发送确认超时，终端可能已收到。请先查看全文，确认后再决定是否重发。'
      : `未确认发送成功，请先查看全文，再决定是否重发：${e.message}`
    if (item) { item.status = 'uncertain'; item.error = message }
    else inputErrors.value[name] = message
  }
  finally {
    clearTimeout(confirmationTimeout)
    if (inputRequest === request) inputRequest = null
    sending.value = false
  }
}
onBeforeUnmount(() => {
  disposed = true; epoch++; clearTimeout(timer); clearInterval(elapsedTimer); releaseReadGuard()
  inputRequest?.abort()
  document.removeEventListener('visibilitychange', resumeReading); window.removeEventListener('online', resumeReading)
  window.removeEventListener('focus', resumeReading); window.removeEventListener('pageshow', restoredPage)
})
</script>
<template>
  <section class="mobile-terminal" :style="{ '--reading-size': `${fontSize}px` }">
    <div v-if="navigationOpen" id="mobile-navigation" class="mobile-navigation" role="group" aria-label="终端方向键、回车、组合键和 ESC">
      <button v-for="key in ['Up', 'Down', 'Left', 'Right', 'Enter', 'S-Left', 'Escape']" :key="key" type="button" :class="{ 'wide-key': ['Enter', 'S-Left', 'Escape'].includes(key) }"
        :aria-label="{Up:'方向键上', Down:'方向键下', Left:'方向键左', Right:'方向键右', Enter:'终端回车', 'S-Left':'Shift 加左方向键', Escape:'终端 ESC'}[key]"
        :disabled="sending || store.cachedSnapshot || session?.status !== 'running'" @click="send(key, false)">{{ {Up:'↑', Down:'↓', Left:'←', Right:'→', Enter:'↵ 回车', 'S-Left':'Shift+←', Escape:'ESC'}[key] }}</button>
    </div>
    <template v-if="session">
      <div class="mobile-session-header">
        <div class="mobile-title-row">
          <div class="mobile-session-title" :title="session.displayName || session.name">{{ session.displayName || session.name }}</div>
          <ActivityBadge class="inline-status" :status="status" :title="elapsed ? `${status.detail}（本轮已运行 ${elapsed}）` : status.detail" />
          <span v-if="elapsed" class="elapsed">已运行 {{ elapsed }}</span>
        </div>
        <!-- Unavailable status stays in the title row; it needs no separate action or reading space. -->
        <div v-if="['waiting', 'error', 'interrupted'].includes(status.state) && !(status.state === 'waiting' && questionPending)" class="status-guidance" :class="status.state">
          <p>{{ status.state === 'waiting' && questionSupport === false ? '此会话需在全文中作答，请按终端提示选择或跳过。' : status.detail }}</p>
          <button v-if="!showExecution" type="button" @click="emit('show-execution', status.state === 'waiting')">查看全文 <span aria-hidden="true">↗</span></button>
        </div>
      </div>
      <div ref="pane" class="mobile-reading" @scroll.passive="scrolled">
        <template v-if="!showExecution && messages.length">
          <article v-for="message in messages" :key="message.id" :class="['message', message.role]">
            <div class="speaker">{{ message.role === 'user' ? '你' : message.phase === 'commentary' ? 'Codex · 工作进展' : 'Codex · 回复' }}</div>
            <div class="markdown" v-html="message.html"></div>
          </article>
        </template>
        <div v-else-if="showExecution || !codexAnswer" class="terminal-segments">
          <template v-for="(segment, index) in outputSegments" :key="index">
            <div v-if="segment.type === 'table'" class="terminal-table" role="region" aria-label="终端表格，可左右滑动" tabindex="0">
              <table><tbody><tr v-for="(row, r) in segment.rows" :key="r"><td v-for="(cell, c) in row" :key="c">{{ cell }}</td></tr></tbody></table>
            </div>
            <pre v-else class="mobile-output"><span v-for="(run, i) in segment.runs" :key="i" :style="run.style">{{ run.text }}</span></pre>
          </template>
        </div>
        <div v-if="codexAnswer && (answerUnavailable || !messages.length)" class="reading-placeholder answer-placeholder" role="status">
          <p>{{ answerPlaceholder }}</p>
          <button type="button" @click="emit('show-execution', true)">查看全文</button>
        </div>
        <article v-for="item in pendingMessages" :key="item.id" class="pending-message" :class="item.status" :role="item.status === 'uncertain' ? 'alert' : 'status'">
          <div class="pending-text">{{ item.text }}</div>
          <div class="pending-status">
            <span>{{ item.status === 'sending' ? '发送中…' : item.status === 'delivered' ? (item.codex ? '已送达终端 · 等待 Codex 确认接收' : '已发送到终端') : item.error || '发送结果未确认，请查看全文模式后再决定是否重发' }}</span>
            <button v-if="item.status !== 'sending'" type="button" aria-label="关闭发送提示" @click="dismissPending(item.id)">×</button>
          </div>
        </article>
        <div v-if="!codexAnswer && !Object.keys(content).length && !error" class="reading-placeholder" role="status">{{ store.cachedSnapshot ? '此视图暂无本地缓存，联网后自动加载。' : '正在加载会话…' }}</div>
      </div>
      <button v-if="!follow" class="latest" @click="bottom">↓ 回到最新</button>
      <p v-if="inputError || (error && !answerUnavailable)" class="mobile-error" role="alert">{{ inputError || error }}</p>
      <CodexQuestions v-if="!store.cachedSnapshot && session.status === 'running' && session.activity?.detected" :session-name="session.name" @handled="refresh()" @pending="questionPending = $event" @support="questionSupport = $event" />
      <form v-if="session.status === 'running'" class="composer" @submit.prevent="send()">
        <p v-if="inputNotice" class="input-notice" role="status">{{ inputNotice }}</p>
        <div v-if="more" class="keys"><button v-for="key in ['Escape', 'Tab', 'C-c']" :key="key" type="button" :disabled="sending || store.cachedSnapshot" @click="send(key, false)">{{ {Escape:'Esc', Up:'↑', Down:'↓', Left:'←', Right:'→', Tab:'Tab', 'C-c':'中断'}[key] }}</button><button type="button" :disabled="sending || store.cachedSnapshot || !draft" @click="send(null)">仅输入</button></div>
        <div class="compose-row"><button type="button" class="extra" :aria-expanded="more" aria-label="终端按键" @click="more = !more">＋</button>
          <textarea ref="composerInput" v-model="draft" aria-label="消息输入" :placeholder="status.state === 'waiting' ? '输入回答或补充说明…' : session.activity?.busy ? '补充要求，或输入下一条消息…' : '输入消息，继续工作…'" rows="2" enterkeyhint="enter"></textarea>
          <button class="send" :disabled="sending || store.cachedSnapshot" type="submit">{{ sending ? '…' : draft ? '发送' : '回车' }}</button></div>
      </form>
    </template>
    <div v-else class="mobile-empty">从左上角选择会话，继续你的工作。</div>
  </section>
</template>
<style scoped>
.mobile-terminal { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; position:relative; background:#0e1420; color:#e5eaf2 }
.mobile-navigation { display:flex; gap:4px; padding:8px; border-bottom:1px solid #263143; flex-shrink:0; background:#131c2a; }
.mobile-navigation button { flex:1; min-width:0; padding:6px 4px; font-size:20px; }
.mobile-navigation button.wide-key { flex:1.6; font-size:13px; white-space:nowrap; }
@media (max-width:359px) {
  .mobile-navigation { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); }
  .mobile-navigation button:nth-child(6) { grid-column:span 2; }
}
.mobile-session-header { padding:10px 12px; border-bottom:1px solid #263143; background:#111a28; flex-shrink:0; }
.mobile-title-row { display:flex; align-items:center; gap:8px; min-width:0; }
.mobile-session-title { min-width:0; font-size:15px; font-weight:600; line-height:1.5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.inline-status { flex-shrink:0; white-space:nowrap; }
.inline-status.busy :deep(.activity-dot) { display:none; }
.elapsed { display:none; color:#98a9c0; font-size:11px; font-variant-numeric:tabular-nums; flex-shrink:0; white-space:nowrap; }
@media (min-width:600px) { .elapsed { display:inline; margin-left:auto; } }
.status-guidance { display:flex; align-items:center; gap:8px; margin-top:10px; padding:10px 12px; background:#1b2739; border-radius:10px; font-size:12px; line-height:1.6; color:#c1cede; }
.status-guidance.waiting { background:#342b19; color:#fde68a; }.status-guidance.error { background:#34202a; color:#fecdd3; }
.status-guidance p { flex:1; min-width:0; }.status-guidance button { flex-shrink:0; padding:6px 8px; font-size:12px; background:transparent; color:inherit; text-decoration:underline; }
.mobile-reading { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:18px 16px; touch-action:pan-x pan-y pinch-zoom; }
.reading-placeholder { color:#98a9c0; font-size:14px; text-align:center; padding:24px 0; }
.answer-placeholder p { margin:0 0 12px; }.answer-placeholder button { color:#a9d7ff; background:transparent; text-decoration:underline; }
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
.composer { padding:10px 12px; padding-bottom:max(10px, env(safe-area-inset-bottom)); border-top:1px solid #263143; background:#131c2a; }
.compose-row { display:flex; gap:8px; align-items:center }
textarea { flex:1; min-width:0; resize:none; max-height:160px; font:16px/1.5 sans-serif; background:#1d293b; color:#f1f5f9; border:1px solid #40516b; border-radius:12px; padding:10px; }
button { min-height:44px; border:0; border-radius:10px; padding:8px 12px; background:#25364b; color:#e2e8f0; font-size:14px }
.send { background:#2563eb; color:white; } button:disabled { opacity:.55 }
.extra { padding:8px; font-size:22px }
.keys { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px }
.latest { position:absolute; right:16px; bottom:110px; box-shadow:0 3px 15px #0008 }
.mobile-error { padding:8px 16px; color:#fda4af; font-size:13px }
.input-notice { margin:0 0 6px; color:#98a9c0; font-size:12px; }
.mobile-empty { margin:auto; padding:20px; color:#94a3b8 }
@media (max-height: 550px) {
  .mobile-session-header { padding:6px 12px; }.status-guidance { padding:4px 8px; margin-top:4px; }
  .mobile-reading { padding:12px; }.composer { padding-top:6px; }
}
</style>
