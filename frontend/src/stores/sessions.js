import { hubUrl } from '../utils/base.mjs'
import { pruneContent } from '../utils/session-content.mjs'
import { defineStore } from 'pinia'
import { ref, computed, onScopeDispose, watch } from 'vue'
import { LAYOUT_KEY, normalizeLayout, orderedSessions, moveSession } from '../utils/session-layout.mjs'
import { activityState as classifyActivity, activityPresentation } from '../utils/activity.mjs'
import { createSessionSync } from '../utils/session-sync.mjs'
import { loadMetadata, saveMetadata, scopedStorageKey } from '../utils/session-metadata.mjs'

export const useSessionStore = defineStore('sessions', () => {
  const cached = loadMetadata()
  const sessions = ref(cached?.sessions || [])
  const cachedSnapshot = ref(Boolean(cached))
  const connectionIssue = ref(Boolean(cached))
  const readKey = scopedStorageKey('web-ttyd-hub.read.v1')
  const layoutKey = scopedStorageKey(LAYOUT_KEY)
  const read = ref(cached?.read || {})
  if (!cached) try { read.value = JSON.parse(localStorage.getItem(readKey)) || {} } catch {}
  let readGuard = null
  function setReadGuard(guard) {
    readGuard = guard
    return () => { if (readGuard === guard) readGuard = null }
  }
  function markRead() {
    if (document.hidden || !document.hasFocus() || connectionIssue.value) return
    const session = sessions.value.find(s => s.name === current.value)
    if (session && !session.archivedAt && activityState(session) === 'unread' && readGuard?.(session)) {
      if (sync.enabled) {
        sync.enqueue({ type: 'read', name: session.name, createdAt: session.createdAt, completed: session.activity.completed })
        return
      }
      read.value[session.name] = session.activity.completed
      try { localStorage.setItem(readKey, JSON.stringify(read.value)) } catch {}
      // Promote once per newly read completion. Status and pin groups still take
      // priority, and later refreshes must not undo the user's manual ordering.
      saveLayout({ ...layout.value, order: [session.name, ...layout.value.order.filter(name => name !== session.name)] })
    }
  }
  function activityState(session) {
    return connectionIssue.value ? 'unknown' : classifyActivity(session, read.value)
  }
  const activityStatus = session => cachedSnapshot.value
    ? { state: 'unknown', label: '本地缓存', detail: '正在连接并更新状态，当前显示上次保存的内容。' }
    : activityPresentation(session, read.value, connectionIssue.value)
  document.addEventListener('visibilitychange', markRead)
  window.addEventListener('focus', markRead)
  onScopeDispose(() => { document.removeEventListener('visibilitychange', markRead); window.removeEventListener('focus', markRead) })
  const shells = ref(cached?.shells || [])
  const platform = ref(cached?.platform || '')
  const selectionKey = scopedStorageKey('web-ttyd-hub.last-session.v1')
  let savedSelection = cached?.selection
  try { savedSelection = JSON.parse(localStorage.getItem(selectionKey)) || savedSelection } catch {}
  const current = ref(cached?.sessions.find(s => s.name === savedSelection?.name &&
    s.createdAt === savedSelection?.createdAt && !s.archivedAt)?.name || null)
  const loaded = ref(Boolean(cached))
  let restoreSelection = true
  let metadataTimer = null, lastShared = null, hasConfirmedList = Boolean(cached)
  function persistMetadata() {
    clearTimeout(metadataTimer); metadataTimer = null
    if (!hasConfirmedList) return
    const confirmedRead = lastShared ? Object.fromEntries(sessions.value.filter(s => lastShared.read?.[s.name]?.createdAt === s.createdAt)
      .map(s => [s.name, lastShared.read[s.name].completed])) : cachedSnapshot.value && cached ? cached.read : read.value
    const confirmedLayout = lastShared ? normalizeLayout(lastShared.layout) : cachedSnapshot.value && cached ? cached.layout : layout.value
    const selected = sessions.value.find(s => s.name === current.value && !s.archivedAt)
    saveMetadata({ sessions: sessions.value, read: confirmedRead, layout: confirmedLayout,
      shells: shells.value, platform: platform.value,
      selection: selected ? { name: selected.name, createdAt: selected.createdAt } : null })
  }
  function scheduleMetadata() {
    if (!metadataTimer) metadataTimer = setTimeout(persistMetadata, 500)
  }
  function rememberSelection(session) {
    savedSelection = session && !session.archivedAt ? { name: session.name, createdAt: session.createdAt || null } : null
    try {
      if (session && !session.archivedAt) {
        localStorage.setItem(selectionKey, JSON.stringify(savedSelection))
      } else localStorage.removeItem(selectionKey)
    } catch {} // Storage restrictions must not prevent opening a terminal.
    scheduleMetadata()
  }
  watch([current, sessions], markRead)
  const layout = ref(normalizeLayout(cached?.layout))
  const layoutError = ref('')
  if (!cached) try { layout.value = normalizeLayout(JSON.parse(localStorage.getItem(layoutKey))) } catch {}
  const sync = createSessionSync({
    sessions: () => sessions.value, legacyRead: cached ? {} : { ...read.value }, legacyLayout: layout.value,
    preview: cached ? { layout: cached.layout, read: Object.fromEntries(cached.sessions.filter(s => cached.read[s.name])
      .map(s => [s.name, { createdAt: s.createdAt, completed: cached.read[s.name] }])) } : null,
    confirmed: value => { lastShared = value; scheduleMetadata() },
    apply: value => {
      read.value = value.read; layout.value = value.layout
      try {
        localStorage.setItem(readKey, JSON.stringify(value.read))
        localStorage.setItem(layoutKey, JSON.stringify(value.layout))
      } catch {} // Confirmed shared state is durable even when local storage is unavailable.
      scheduleMetadata()
    },
    error: message => { layoutError.value = message },
    refresh: () => refreshVisible(),
  })
  onScopeDispose(() => sync.dispose())
  const sortedSessions = computed(() => orderedSessions(sessions.value.filter(s => !s.archivedAt), layout.value, activityState))
  const archivedSessions = computed(() => sessions.value.filter(s => s.archivedAt).sort((a,b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt)))
  const otherSessions = computed(() => sortedSessions.value.filter(s => s.name !== current.value))
  const unreadSessions = computed(() => otherSessions.value.filter(s => activityState(s) === 'unread'))
  const unreadCount = computed(() => unreadSessions.value.length)
  const workingCount = computed(() => otherSessions.value.filter(s => activityState(s) === 'busy').length)
  const isPinned = name => layout.value.pinned.includes(name)
  function saveLayout(value) {
    layout.value = value
    try {
      localStorage.setItem(layoutKey, JSON.stringify(value))
      layoutError.value = ''
    } catch {
      layoutError.value = '无法保存排列，刷新后可能丢失。请允许浏览器存储。'
    }
    scheduleMetadata()
  }
  function togglePin(name) {
    const session = sessions.value.find(s => s.name === name)
    if ((sync.enabled || cachedSnapshot.value) && session) {
      sync.enqueue({ type: 'pin', name, createdAt: session.createdAt, pinned: !isPinned(name) })
      return
    }
    const pinned = isPinned(name) ? layout.value.pinned.filter(x => x !== name) : [...layout.value.pinned, name]
    saveLayout({ order: [name, ...sortedSessions.value.map(s => s.name).filter(x => x !== name)], pinned })
  }
  function reorderSession(name, target, after) {
    if (sync.enabled || cachedSnapshot.value) {
      const session = sessions.value.find(s => s.name === name), other = sessions.value.find(s => s.name === target)
      if (session && other) sync.enqueue({ type: 'move', name, createdAt: session.createdAt,
        target, targetCreatedAt: other.createdAt, after: !!after })
      return
    }
    saveLayout(moveSession(sessions.value, layout.value, name, target, after))
  }
  function moveByKeyboard(name, direction) {
    const group = sortedSessions.value.filter(s => isPinned(s.name) === isPinned(name))
    const target = group[group.findIndex(s => s.name === name) + direction]
    if (target) reorderSession(name, target.name, direction > 0)
  }
  function syncLayout(event) {
    if (sync.enabled) return
    if (event.key !== layoutKey && event.key !== null) return
    try { layout.value = normalizeLayout(JSON.parse(event.newValue)) } catch {}
    scheduleMetadata()
  }
  window.addEventListener('storage', syncLayout)
  onScopeDispose(() => window.removeEventListener('storage', syncLayout))
  let ws = null
  let reconnectTimer = null
  let reconnectDelay = 1000

  let listRequest = null, refreshPending = false, activitySequence = 0
  const liveActivity = new Map()
  function receiveShared(value) {
    const accepted = sync.receive(value)
    if (accepted) scheduleMetadata()
    return accepted
  }
  function receiveActivity(value) {
    const session = sessions.value.find(s => s.name === value?.name && s.createdAt === value.createdAt)
    if (!session || !value.activity || typeof value.activity !== 'object') return false
    liveActivity.set(value.name, { sequence: ++activitySequence, createdAt: value.createdAt, activity: value.activity })
    // The notification already contains the authoritative state. A second HTTP
    // round trip adds latency and can stall behind an unrelated list request.
    sessions.value = sessions.value.map(s => s === session ? { ...s, activity: value.activity } : s)
    // One fresh event cannot validate every other session restored from disk.
    if (!cachedSnapshot.value) connectionIssue.value = false
    scheduleMetadata()
    return true
  }
  function receiveList(data) {
    const selected = sessions.value.find(s => s.name === current.value)
    cachedSnapshot.value = false
    connectionIssue.value = false
    hasConfirmedList = true
    void pruneContent(data.sessions)
    sessions.value = data.sessions
    receiveShared(data.shared)
    if (restoreSelection) {
      let saved = savedSelection
      try { saved = JSON.parse(localStorage.getItem(selectionKey)) } catch {}
      // A failed request must not discard selection or attach to a replacement.
      const previous = data.sessions.find(s => s.name === saved?.name &&
        (s.createdAt || null) === saved?.createdAt && !s.archivedAt)
      select(previous?.name || null)
    } else if (current.value && !data.sessions.some(s => s.name === current.value && !s.archivedAt &&
      (!selected || (s.createdAt || null) === (selected.createdAt || null)))) select(null)
    loaded.value = true
    scheduleMetadata()
  }
  function receiveSnapshot(data) {
    if (!Array.isArray(data?.sessions)) return false
    // The opening snapshot supersedes all HTTP work issued before reconnecting.
    // It also recovers events sent while the new socket was being established.
    listRequest?.abort(); listRequest = null; refreshPending = false
    liveActivity.clear(); activitySequence++
    receiveList(data)
    return true
  }
  async function fetchSessions() {
    listRequest?.abort()
    const request = new AbortController()
    listRequest = request
    const timeout = setTimeout(() => request.abort(), 10000)
    const activityAtStart = activitySequence
    try {
      const res = await fetch(hubUrl('/api/sessions'), { signal: request.signal, cache: 'no-store' })
      if (!res.ok) throw new Error('无法读取会话列表')
      const data = await res.json()
      if (!Array.isArray(data.sessions)) throw new Error('会话列表格式无效')
      if (listRequest !== request || request.signal.aborted) return
      data.sessions = data.sessions.map(session => {
        const event = liveActivity.get(session.name)
        return event && event.sequence > activityAtStart && event.createdAt === session.createdAt
          ? { ...session, activity: event.activity } : session
      })
      for (const [name, event] of liveActivity) if (event.sequence <= activityAtStart ||
        !data.sessions.some(s => s.name === name && s.createdAt === event.createdAt)) liveActivity.delete(name)
      receiveList(data)
    } catch (error) {
      // Reconnect/snapshot intentionally replaces this read; callers of a
      // successful rename/create must not receive a spurious cancellation error.
      if (listRequest !== request) return
      if (activitySequence === activityAtStart) connectionIssue.value = true
      throw error
    } finally {
      clearTimeout(timeout)
      if (listRequest === request) {
        listRequest = null
        if (refreshPending) { refreshPending = false; refreshVisible() }
      }
    }
  }

  async function fetchShells() {
    const res = await fetch(hubUrl('/api/sessions/shells'))
    if (!res.ok) throw new Error('无法读取终端类型')
    const data = await res.json()
    if (!Array.isArray(data.shells)) throw new Error('终端类型格式无效')
    shells.value = data.shells
    platform.value = data.platform || ''
    scheduleMetadata()
  }

  async function createSession(name, shell, cwd, resumeThreadId) {
    const res = await fetch(hubUrl('/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, shell, ...(cwd ? { cwd } : {}), ...(resumeThreadId ? { resumeThreadId } : {}) })
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
    const res = await fetch(hubUrl(`/api/sessions/${encodeURIComponent(name)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: displayName })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    await fetchSessions()
  }

  async function stopSession(name) {
    const res = await fetch(hubUrl(`/api/sessions/${name}/stop`), { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error)
    }
    await fetchSessions()
  }

  async function restartSession(name) {
    const res = await fetch(hubUrl(`/api/sessions/${name}/restart`), { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error)
    }
    await fetchSessions()
  }

  async function removeSession(name, permanent = false) {
    const res = await fetch(hubUrl(`/api/sessions/${name}${permanent ? '/permanent' : ''}`), { method: 'DELETE' })
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
    const res = await fetch(hubUrl(`/api/sessions/${name}/restore`), { method: 'POST' })
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

  function selectNextUnread() {
    const next = unreadSessions.value[0]
    if (next) select(next.name)
  }

  function selectNextWorking() {
    // Advance from the current worker before wrapping; choosing the first
    // other worker each time would bounce between two and miss later ones.
    const working = sortedSessions.value.filter(s => activityState(s) === 'busy')
    const index = working.findIndex(s => s.name === current.value)
    const next = working[index + 1] || working[0]
    if (next && next.name !== current.value) select(next.name)
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    try { ws = new WebSocket(`${proto}://${location.host}${hubUrl('/ws')}`) }
    catch {
      // WebViews may reject a socket before any close event can be delivered.
      // Keep the HTTP startup/reconciliation path and the page usable.
      scheduleReconnect()
      return
    }

    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data)
        if (message.event === 'session:snapshot' && receiveSnapshot(message.data)) return
        if (message.event === 'session:activity' && receiveActivity(message.data)) return
        if (message.event === 'session:sync' && receiveShared(message.data)) return
      } catch { /* A malformed notification falls back to a full reconciliation. */ }
      refreshVisible(true)
    }

    ws.onopen = () => {
      reconnectDelay = 1000
      // Recover completions that happened while a phone's connection was asleep.
      // Reuse the HTTP read already in progress: flapping notification sockets
      // must not repeatedly abort a slow initial list and starve its first load.
      refreshVisible()
    }

    ws.onclose = () => {
      // A failed notification channel does not invalidate a successful HTTP
      // snapshot. Let that independent authoritative read decide freshness.
      refreshVisible()
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
    if (refreshTimer) return
    fetchSessions().catch(() => {})
    fetchShells().catch(() => {})
    connectWs()
    refreshTimer = setInterval(refreshVisible, 5000)
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('pageshow', resumePage)
  }

  // Phones can suspend a WebSocket without delivering close. Refresh on return
  // and periodically reconcile, even when no activity notification arrives.
  const refreshVisible = (fresh = false) => {
    if (document.hidden) return
    if (listRequest && !fresh) { refreshPending = true; return }
    refreshPending = false
    fetchSessions().catch(() => {})
  }
  const resume = () => {
    if (document.hidden) { persistMetadata(); return }
    refreshVisible(true)
    sync.retry()
    // WebViews can keep an OPEN socket whose network connection died in the
    // background. A fresh connection must not depend on its missing close event.
    clearTimeout(reconnectTimer); reconnectTimer = null
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; ws.close() }
    connectWs()
  }
  // A restored browser page or Android WebView can return to the foreground
  // without changing document.hidden. Neither path should need a terminal input.
  const resumePage = event => { if (event.persisted) resume() }
  let refreshTimer
  onScopeDispose(() => {
    persistMetadata()
    clearInterval(refreshTimer); clearTimeout(reconnectTimer)
    listRequest?.abort(); listRequest = null
    if (ws) { ws.onclose = null; ws.close() }
    document.removeEventListener('visibilitychange', resume)
    window.removeEventListener('online', resume)
    window.removeEventListener('focus', resume)
    window.removeEventListener('pageshow', resumePage)
  })
  window.addEventListener('pagehide', persistMetadata)
  onScopeDispose(() => window.removeEventListener('pagehide', persistMetadata))

  async function create({ command, name, cwd, resumeThreadId }) {
    return createSession(name || null, command || null, cwd, resumeThreadId)
  }

  return {
    sessions,
    activityState,
    activityStatus,
    setReadGuard,
    markRead,
    connectionIssue,
    cachedSnapshot,
    sortedSessions,
    archivedSessions,
    unreadCount,
    workingCount,
    selectNextUnread,
    selectNextWorking,
    restoreSession,
    layoutError,
    isPinned,
    togglePin,
    reorderSession,
    moveByKeyboard,
    shells,
    platform,
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
