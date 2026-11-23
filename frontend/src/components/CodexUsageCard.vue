<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { hubUrl } from '../utils/base.mjs'
import { pageHidden, receiveVisibility } from '../utils/page-visibility.mjs'
import { untilAbort } from '../utils/request-deadline.mjs'

const props = defineProps({ menuOpen: Boolean })
const expanded = ref(false)
const loading = ref(false)
const data = ref(null)
const error = ref('')
const weekly = computed(() => data.value?.windows?.find(window =>
  window.id.startsWith('codex:') && window.period === '每周额度'))
const stale = computed(() => Boolean(error.value || data.value?.stale))
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
})
function time(value) {
  return value ? dateFormat.format(new Date(value)) : '暂未提供'
}

let currentRequest
const foreground = ref(!pageHidden())
const lifecycle = new AbortController()
function updateForeground(event) {
  receiveVisibility(event)
  foreground.value = event.type !== 'pagehide' && !pageHidden()
}
document.addEventListener('visibilitychange', updateForeground, { signal: lifecycle.signal })
for (const event of ['hub:visibility', 'pagehide', 'pageshow', 'focus']) {
  window.addEventListener(event, updateForeground, { signal: lifecycle.signal })
}

let remainingMs = 0
watch(() => expanded.value && !loading.value && props.menuOpen && foreground.value, (visible, _, onCleanup) => {
  if (!visible) return
  const started = performance.now()
  const timer = setTimeout(collapse, Math.ceil(remainingMs))
  onCleanup(() => {
    clearTimeout(timer)
    remainingMs = Math.max(0, remainingMs - (performance.now() - started))
  })
}, { flush: 'post' })

function collapse() {
  expanded.value = false
  currentRequest?.abort()
  currentRequest = null
}

async function toggle() {
  if (expanded.value) return collapse()
  expanded.value = true
  loading.value = true
  error.value = ''
  const request = new AbortController()
  currentRequest = request
  const deadline = setTimeout(() => request.abort(), 45000)
  try {
    const response = await untilAbort(fetch(hubUrl('/api/sessions/codex-usage?refresh=1'), {
      signal: request.signal, cache: 'no-store'
    }), request.signal)
    if (!response.ok) throw new Error('额度读取失败')
    const result = await untilAbort(response.json(), request.signal)
    if (currentRequest === request) data.value = result
  } catch {
    if (currentRequest === request) error.value = request.signal.aborted ? '查询超时' : '暂时无法查询额度'
  } finally {
    clearTimeout(deadline)
    if (currentRequest === request) {
      currentRequest = null
      remainingMs = 60000
      loading.value = false
    }
  }
}
onBeforeUnmount(() => {
  lifecycle.abort()
  collapse()
})
</script>

<template>
  <div v-show="menuOpen" class="usage-card" :class="{ expanded }" @keydown.esc.stop="collapse">
    <div id="account-usage-details" class="reveal" :aria-hidden="!expanded">
      <div class="clip">
        <div class="details" role="status" aria-live="polite" aria-atomic="true">
          <p v-if="loading" class="notice"><span class="spinner" aria-hidden="true"></span>正在查询额度…</p>
          <template v-else-if="weekly">
            <div class="balance"><span>Codex 每周剩余</span><strong>{{ Math.round(weekly.remainingPercent * 10) / 10 }}%</strong></div>
            <dl>
              <div><dt>重置时间</dt><dd>{{ time(weekly.resetsAt) }}</dd></div>
              <div><dt>{{ stale ? '上次成功更新' : '更新时间' }}</dt><dd>{{ time(data.fetchedAt) }}</dd></div>
            </dl>
            <p v-if="stale" class="stale">当前查询失败，显示上次额度</p>
          </template>
          <p v-else class="notice">{{ error || (data?.stale ? '暂时无法查询额度' : '暂无 Codex 每周额度数据') }}</p>
        </div>
      </div>
    </div>
    <button type="button" class="toggle" :aria-expanded="expanded" aria-controls="account-usage-details" @click="toggle">
      <span class="usage-icon" aria-hidden="true"></span>账号额度<span class="chevron" aria-hidden="true"></span>
    </button>
  </div>
</template>

<style scoped>
.usage-card {
  flex: 0 0 auto;
  margin: 8px 12px;
  border: 1px solid var(--border-color-hover);
  border-radius: 10px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
.reveal {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 220ms ease-in-out, opacity 180ms ease;
}
.expanded .reveal { grid-template-rows: 1fr; opacity: 1; }
.clip { min-height: 0; overflow: hidden; }
.details {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 108px;
  margin: 0 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-color-hover);
}
.balance, dl div, .toggle, .notice { display: flex; align-items: center; }
.balance, dl div { justify-content: space-between; gap: 6px; }
.balance { margin-bottom: 5px; font-size: 13px; }
.balance strong { color: #bae6fd; font-size: 25px; line-height: 1.3; }
dl { font-size: 12px; line-height: 1.8; }
dt, .notice { color: #cbd5e1; }
dd, strong { font-variant-numeric: tabular-nums; }
.stale { color: #fde68a; font-size: 12px; }
.notice { gap: 8px; font-size: 13px; }
.spinner {
  width: 14px; height: 14px;
  border: 2px solid var(--border-color-hover);
  border-top-color: #bae6fd;
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}
.usage-card:not(.expanded) .spinner { animation-play-state: paused; }
@keyframes spin { to { transform: rotate(360deg); } }
.toggle {
  width: 100%;
  min-height: 44px;
  gap: 10px;
  padding: 8px 12px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.toggle:focus-visible { outline: 2px solid #7dd3fc; outline-offset: -2px; }
.usage-icon {
  width: 15px; height: 15px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  background: conic-gradient(currentColor 25%, transparent 25%);
}
.chevron {
  width: 7px; height: 7px;
  margin-left: auto;
  border-top: 1.5px solid currentColor;
  border-right: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 220ms ease;
}
.expanded .chevron { transform: rotate(135deg); }
@media (prefers-reduced-motion: reduce) {
  .reveal, .chevron { transition: none; }
  .spinner { animation: none; }
}
</style>
