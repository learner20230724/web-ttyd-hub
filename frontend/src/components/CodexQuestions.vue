<script setup>
import { ref, reactive, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { hubUrl } from '../utils/base.mjs'
const props = defineProps({ sessionName: { type: String, required: true } })
const emit = defineEmits(['handled', 'pending', 'support'])
const requests = ref([]), connected = ref(false), sending = ref(false), error = ref(''), notice = ref(''), opened = ref(null), dialog = ref(null)
const drafts = reactive(new Map())
const current = computed(() => requests.value.find(r => r.id === opened.value) || requests.value[0])
watch(() => requests.value.length, length => emit('pending', length > 0), { immediate: true })
let epoch = 0, pollId = 0, disposed = false, timer, controller, submitController, noticeTimer
function answers(request) {
  if (!drafts.has(request.id)) drafts.set(request.id, { choices: Object.create(null), text: Object.create(null) })
  return drafts.get(request.id)
}
function responseText(request, question) {
  const draft = answers(request), selected = draft.choices[question.id], text = (draft.text[question.id] || '').trim()
  const option = question.options?.find(o => o.label === selected)?.label || ''
  return option && text ? `${option}\n补充：${text}` : option || text
}
const complete = computed(() => current.value?.questions.every(q => responseText(current.value, q)))
function close() { opened.value = null; dialog.value?.close() }
async function open() { if (!current.value) return; opened.value = current.value.id; await nextTick(); dialog.value?.showModal() }
async function poll(token = epoch) {
  if (disposed || token !== epoch) return
  clearTimeout(timer)
  if (document.hidden) { connected.value = false; timer = setTimeout(() => poll(token), 1500); return }
  const name = props.sessionName, id = ++pollId, requestController = new AbortController(); controller = requestController
  const timeout = setTimeout(() => requestController.abort(), 15000)
  try {
    const response = await fetch(hubUrl(`/api/sessions/${encodeURIComponent(name)}/questions`), { signal: controller.signal, cache: 'no-store' })
    const data = await response.json(); if (!response.ok) throw Error('追问连接暂不可用')
    if (token !== epoch || id !== pollId || disposed) return
    requests.value = data.requests || []; connected.value = data.supported === true
    emit('support', data.supported === true)
    if (opened.value && !requests.value.some(r => r.id === opened.value)) close()
    // Keep other sessions' drafts in memory, with a fixed upper bound.
    if (drafts.size > 60) drafts.delete(drafts.keys().next().value)
  } catch { if (token === epoch && id === pollId) connected.value = false }
  finally { clearTimeout(timeout); if (!disposed && token === epoch && id === pollId) timer = setTimeout(() => poll(token), 1500) }
}
async function submit(action) {
  const request = current.value, name = props.sessionName, token = epoch
  if (!request || sending.value || request.submitting || !connected.value || (action === 'answer' && !complete.value)) return
  sending.value = true; error.value = ''; submitController = new AbortController()
  const timeout = setTimeout(() => submitController.abort(), 15000)
  try {
    const response = await fetch(hubUrl(`/api/sessions/${encodeURIComponent(name)}/questions/${encodeURIComponent(request.id)}/respond`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: submitController.signal,
      body: JSON.stringify({ action, ...(action === 'answer' ? { answers: Object.fromEntries(request.questions.map(q => [q.id, responseText(request, q)])) } : {}) }),
    })
    const data = await response.json(); if (!response.ok) throw Error(data.error || '未确认回答是否送达，请查看全文')
    drafts.delete(request.id)
    if (token === epoch) {
      close(); requests.value = requests.value.filter(r => r.id !== request.id)
      notice.value = action === 'skip' ? '已跳过本次追问，任务可继续' : '追问已处理'
      clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.value = '' }, 4500)
      emit('handled')
    }
  } catch (e) { if (token === epoch) error.value = e.name === 'AbortError' ? '回答结果未确认，请查看全文后再操作' : e.message }
  finally { clearTimeout(timeout); sending.value = false; if (token === epoch) { controller?.abort(); clearTimeout(timer); void poll(token) } }
}
watch(() => props.sessionName, () => {
  epoch++; controller?.abort(); clearTimeout(timer); close(); requests.value = []; connected.value = false; error.value = ''; notice.value = ''; emit('support', null); void poll()
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; epoch++; clearTimeout(timer); clearTimeout(noticeTimer); controller?.abort(); submitController?.abort(); dialog.value?.close(); emit('pending', false); emit('support', null) })
</script>
<template>
  <section v-if="current || notice || error" class="question-prompt" aria-label="Codex 追问">
    <template v-if="current">
      <div class="prompt-summary"><strong>{{ current.isBlocking ? '有追问待回答' : 'Codex 想确认一下' }}<span v-if="current.questions.length > 1"> · {{ current.questions.length }} 个问题</span></strong><p>{{ current.questions[0]?.question }}</p></div>
      <div class="prompt-actions"><button type="button" class="primary" :disabled="sending || !connected || current.submitting" @click="open">回答追问</button><button type="button" :disabled="sending || !connected || current.submitting" @click="submit('skip')">跳过追问</button></div>
      <p v-if="!connected" class="question-error" role="status">追问连接暂不可用，请稍候或查看全文。</p>
      <p v-if="sending || current.submitting" role="status">正在提交…</p>
    </template>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="error && !opened" class="question-error" role="alert">{{ error }}</p>
    <dialog ref="dialog" class="question-dialog" aria-labelledby="question-title" @cancel.prevent="close">
      <template v-if="current && opened">
        <header><h2 id="question-title">回答 Codex 追问</h2><button type="button" aria-label="收起追问，保留草稿" @click="close">×</button></header>
        <form @submit.prevent="submit('answer')">
          <div class="question-fields">
            <fieldset v-for="(question, index) in current.questions" :key="question.id" :disabled="sending || current.submitting">
              <legend><small v-if="current.questions.length > 1">问题 {{ index + 1 }} / {{ current.questions.length }}</small>{{ question.question }}</legend>
              <label v-for="(option, n) in question.options" :key="n" class="question-option" :class="{ chosen: answers(current).choices[question.id] === option.label }">
                <input v-model="answers(current).choices[question.id]" type="radio" :name="`${current.id}-${question.id}`" :value="option.label" /><span><b>{{ option.label }}</b><small>{{ option.description }}</small></span>
              </label>
              <label v-if="question.options.length" class="question-option"><input v-model="answers(current).choices[question.id]" type="radio" :name="`${current.id}-${question.id}`" value="" /><span>自行填写</span></label>
              <label class="text-label">{{ question.options.length ? '自行回答或补充说明' : '你的回答' }}
                <input v-if="question.isSecret" v-model="answers(current).text[question.id]" type="password" autocomplete="off" maxlength="16000" />
                <textarea v-else v-model="answers(current).text[question.id]" rows="3" maxlength="16000" placeholder="在这里填写…" />
              </label>
            </fieldset>
          </div>
          <p v-if="error" class="question-error" role="alert">{{ error }}</p>
          <p v-if="!connected" class="question-error" role="status">连接正在恢复，暂不能提交。</p>
          <footer><p>可直接选择或自行填写。跳过会将本次问题留空。</p><div class="prompt-actions"><button type="button" :disabled="sending || !connected || current.submitting" @click="submit('skip')">跳过本次追问</button><button type="submit" class="primary" :disabled="!complete || sending || !connected || current.submitting">{{ sending ? '提交中…' : '提交回答' }}</button></div></footer>
        </form>
      </template>
    </dialog>
  </section>
</template>
<style scoped>
.question-prompt { flex-shrink:0; padding:10px 12px; border-top:1px solid #635336; background:#282719; color:#f5e6b9; font-size:13px; line-height:1.5; }.prompt-summary strong { font-size:13px; }.prompt-summary p { margin:4px 0 8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }.prompt-summary span { font-weight:normal; }
.prompt-actions { display:flex; gap:8px; }.prompt-actions button { flex:1; }button { min-height:44px; padding:8px 12px; border:1px solid #49566a; border-radius:10px; color:#e5eaf2; background:#25364b; font-size:14px; cursor:pointer; }button.primary { background:#2563eb; border-color:#2563eb; color:white; }button:disabled { opacity:.5; cursor:default; }.question-error { color:#fecaca; margin:8px 0; }
.question-dialog { width:min(520px, calc(100vw - 20px)); max-height:calc(100dvh - 24px); margin:auto; box-sizing:border-box; padding:16px; overflow:auto; border:1px solid #344259; border-radius:16px; background:#111b2b; color:#e5eaf2; }.question-dialog::backdrop { background:#000a; }header { display:flex; align-items:center; justify-content:space-between; gap:8px; }h2 { font-size:17px; margin:0; }header button { min-width:44px; font-size:24px; border:0; background:transparent; }fieldset { min-width:0; margin:16px 0; padding:0; border:0; }legend { padding:0; margin-bottom:12px; font-size:16px; line-height:1.6; overflow-wrap:anywhere; width:100%; }legend small { display:block; color:#94a3b8; font-size:12px; }
.question-option { display:flex; align-items:flex-start; gap:10px; padding:12px; margin-bottom:8px; border:1px solid #36455c; border-radius:10px; cursor:pointer; line-height:1.5; min-height:44px; box-sizing:border-box; }.chosen { border-color:#60a5fa; background:#1c3251; }.question-option input { flex-shrink:0; margin-top:4px; accent-color:#60a5fa; }.question-option span { min-width:0; overflow-wrap:anywhere; }.question-option small { display:block; font-size:12px; color:#acbad0; margin-top:3px; }.question-option b { font-weight:500; font-size:14px; }
.text-label { display:block; font-size:13px; color:#b8c6db; }.text-label textarea,.text-label input { box-sizing:border-box; display:block; width:100%; margin-top:8px; border:1px solid #40516b; border-radius:10px; padding:10px; background:#1d293b; color:#f1f5f9; font:16px/1.5 sans-serif; resize:vertical; }footer { padding-bottom:env(safe-area-inset-bottom); }footer p { color:#acbad0; font-size:12px; margin:12px 0; }
@media(max-height:550px) { .question-prompt { padding:6px 12px; }.prompt-summary p { -webkit-line-clamp:1; }.question-dialog { max-height:calc(100dvh - 12px); padding:12px; } }
</style>
