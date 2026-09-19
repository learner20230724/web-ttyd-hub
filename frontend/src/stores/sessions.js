import { pruneContent } from '../utils/session-content.mjs'
import { defineStore } from 'pinia'
import { ref, computed, onScopeDispose, watch } from 'vue'
import { LAYOUT_KEY, normalizeLayout, orderedSessions, moveSession } from '../utils/session-layout.mjs'

export const useSessionStore = defineStore('sessions', () => {
  const sessions = ref([])
  const readKey = 'web-ttyd-hub.read.v1'
  const read = ref({})
  try { read.value = JSON.parse(localStorage.getItem(readKey)) || {} } catch {}
  function markRead() {
    if (document.hidden || !document.hasFocus()) return
    const session = sessions.value.find(s => s.name === current.value)
    if (session && !session.archivedAt && activityState(session) === 'unread') {
      read.value[session.name] = session.activity.completed
      try { localStorage.setItem(readKey, JSON.stringify(read.value)) } catch {}
      // Promote once per newly read completion. Status and pin groups still take
      // priority, and later refreshes must not undo the user's manual ordering.
      saveLayout({ ...layout.value, order: [session.name, ...layout.value.order.filter(name => name !== session.name)] })
    }
  }
  function activityState(session) {
    if (session.status !== 'running') return 'idle'
    if (session.activity?.busy) return 'busy'
    if (session.activity?.completed && read.value[session.name] !== session.activity.completed) return 'unread'
    return 'idle'
  }
  document.addEventListener('visibilitychange', markRead)
  window.addEventListener('focus', markRead)
  onScopeDispose(() => { document.removeEventListener('visibilitychange', markRead); window.removeEventListener('focus', markRead) })
  const shells = ref([])
  const current = ref(null)
  const loaded = ref(false)
  const selectionKey = 'web-ttyd-hub.last-session.v1'
  let restoreSelection = true
  function rememberSelection(session) {
    try {
      if (session && !session.archivedAt) {
        localStorage.setItem(selectionKey, JSON.stringify({ name: session.name, createdAt: session.createdAt || null }))
      } else localStorage.removeItem(selectionKey)
    } catch {} // Storage restrictions must not prevent opening a terminal.
  }
  watch([current, sessions], markRead)
  const layout = ref(normalizeLayout(null))
  const layoutError = ref('')
  try { layout.value = normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY))) } catch {}
  const sortedSessions = computed(() => orderedSessions(sessions.value.filter(s => !s.archivedAt), layout.value, activityState))
  const archivedSessions = computed(() => sessions.value.filter(s => s.archivedAt).sort((a,b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt)))
  const isPinned = name => layout.value.pinned.includes(name)
  function saveLayout(value) {
    layout.value = value
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(value))
      layoutError.value = ''
    } catch {
      layoutError.value = '无法保存排列，刷新后可能丢失。请允许浏览器存储。'
    }
  }
  function togglePin(name) {
    const pinned = isPinned(name) ? layout.value.pinned.filter(x => x !== name) : [...layout.value.pinned, name]
    saveLayout({ order: [name, ...sortedSessions.value.map(s => s.name).filter(x => x !== name)], pinned })
  }
  function reorderSession(name, target, after) {
    saveLayout(moveSession(sessions.value, layout.value, name, target, after))
  }
  function moveByKeyboard(name, direction) {
    const group = sortedSessions.value.filter(s => isPinned(s.name) === isPinned(name))
    const target = group[group.findIndex(s => s.name === name) + direction]
    if (target) reorderSession(name, target.name, direction > 0)
  }
  function syncLayout(event) {
    if (event.key !== LAYOUT_KEY && event.key !== null) return
    try { layout.value = normalizeLayout(JSON.parse(event.newValue)) } catch {}
  }
  window.addEventListener('storage', syncLayout)
  onScopeDispose(() => window.removeEventListener('storage', syncLayout))
  let ws = null
  let reconnectTimer = null
  let reconnectDelay = 1000

  async function fetchSessions() {
    const res = await fetch('/api/sessions')
    if (!res.ok) throw new Error('无法读取会话列表')
    const data = await res.json()
    if (!Array.isArray(data.sessions)) throw new Error('会话列表格式无效')
    void pruneContent(data.sessions)
    sessions.value = data.sessions
    if (restoreSelection) {
      let saved
      try { saved = JSON.parse(localStorage.getItem(selectionKey)) } catch {}
      // Restore only after a successful list response; failed requests must not
      // discard the saved selection or attach to an unrelated recreated session.
      const previous = data.sessions.find(s => s.name === saved?.name &&
        (s.createdAt || null) === saved?.createdAt && !s.archivedAt)
      select(previous?.name || null)
    } else if (current.value && !data.sessions.some(s => s.name === current.value && !s.archivedAt)) select(null)
    loaded.value = true
  }

  async function fetchShells() {
    const res = await fetch('/api/sessions/shells')
    const data = await res.json()
    shells.value = data.shells
  }

  async function createSession(name, shell) {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, shell })
    })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error)
    }
    const session = await res.json()
    restoreSelection = false
    current.value = session.name
    rememberSelection(session)
    await fetchSessions()
  }

  async function renameSession(name, displayName) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: displayName })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    await fetchSessions()
  }

  async function stopSession(name) {
    const res = await fetch(`/api/sessions/${name}/stop`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error)
    }
    await fetchSessions()
  }

  async function restartSession(name) {
    const res = await fetch(`/api/sessions/${name}/restart`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error)
    }
    await fetchSessions()
  }

  async function removeSession(name, permanent = false) {
    const res = await fetch(`/api/sessions/${name}${permanent ? '/permanent' : ''}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error)
    }
    if (current.value === name) {
      select(null)
    }
    await fetchSessions()
  }

  async function restoreSession(name) {
    const res = await fetch(`/api/sessions/${name}/restore`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    await fetchSessions()
  }

  function select(name) {
    restoreSelection = false
    current.value = name
    rememberSelection(sessions.value.find(s => s.name === name))
    markRead()
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onmessage = () => {
      fetchSessions()
    }

    ws.onopen = () => {
      reconnectDelay = 1000
    }

    ws.onclose = () => {
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectWs()
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    }, reconnectDelay)
  }

  function init() {
    fetchSessions()
    fetchShells()
    connectWs()
  }

  async function create({ command, name }) {
    return createSession(name || null, command || null)
  }

  return {
    sessions,
    activityState,
    sortedSessions,
    archivedSessions,
    restoreSession,
    layoutError,
    isPinned,
    togglePin,
    reorderSession,
    moveByKeyboard,
    shells,
    current,
    loaded,
    init,
    fetchSessions,
    createSession,
    create,
    renameSession,
    stopSession,
    restartSession,
    removeSession,
    select
  }
})
