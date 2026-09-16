import { defineStore } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'
import { LAYOUT_KEY, normalizeLayout, orderedSessions, moveSession } from '../utils/session-layout.mjs'

export const useSessionStore = defineStore('sessions', () => {
  const sessions = ref([])
  const shells = ref([])
  const current = ref(null)
  const layout = ref(normalizeLayout(null))
  const layoutError = ref('')
  try { layout.value = normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY))) } catch {}
  const sortedSessions = computed(() => orderedSessions(sessions.value, layout.value))
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
    const data = await res.json()
    sessions.value = data.sessions
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
    current.value = session.name
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

  async function removeSession(name) {
    const res = await fetch(`/api/sessions/${name}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error)
    }
    if (current.value === name) {
      current.value = null
    }
    await fetchSessions()
  }

  function select(name) {
    current.value = name
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
    sortedSessions,
    layoutError,
    isPinned,
    togglePin,
    reorderSession,
    moveByKeyboard,
    shells,
    current,
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
