import { hubUrl } from './base.mjs'
import { normalizeLayout, moveSession } from './session-layout.mjs'

// One outbox per tab/WebView, retained through reload. Confirmed state always
// comes from the Hub; local caches only seed the first upgrade.
export function createSessionSync({ sessions, legacyRead, legacyLayout, apply, error, refresh }) {
  const migrationKey = 'web-ttyd-hub.shared-migrated.v1'
  const pendingKey = 'web-ttyd-hub.shared-pending.v1'
  let shared = null, sending = false, disposed = false, migrated = false, pending = []
  try { migrated = localStorage.getItem(migrationKey) === '1' } catch {}
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingKey))
    if (Array.isArray(saved)) pending = saved.slice(0, 1000).filter(op => op && ['read', 'pin', 'move', 'initialize'].includes(op.type))
  } catch {}
  const save = () => { try { sessionStorage.setItem(pendingKey, JSON.stringify(pending)) } catch {} }
  function render() {
    if (!shared || disposed) return
    const list = sessions(), read = Object.create(null)
    for (const session of list) {
      const marker = shared.read[session.name]
      if (marker?.createdAt === session.createdAt) read[session.name] = marker.completed
    }
    let layout = normalizeLayout(shared.layout)
    for (const op of pending) {
      if (op.type === 'initialize') {
        if (shared.layout === null) layout = normalizeLayout(op.layout)
        continue
      }
      const session = list.find(s => s.name === op.name && s.createdAt === op.createdAt && !s.archivedAt)
      if (!session) continue
      if (op.type === 'read') {
        if (session.activity?.completed !== op.completed || read[op.name] === op.completed) continue
        read[op.name] = op.completed
        layout.order = [op.name, ...layout.order.filter(name => name !== op.name)]
      } else if (op.type === 'pin') {
        if (layout.pinned.includes(op.name) === op.pinned) continue
        layout.pinned = op.pinned ? [...layout.pinned, op.name] : layout.pinned.filter(name => name !== op.name)
        layout.order = [op.name, ...layout.order.filter(name => name !== op.name)]
      } else if (list.some(s => s.name === op.target && s.createdAt === op.targetCreatedAt && !s.archivedAt)) {
        layout = moveSession(list, layout, op.name, op.target, op.after)
      }
    }
    apply({ read, layout })
  }
  function accept(value) {
    if (!value || !Number.isSafeInteger(value.revision) || !value.read) return false
    if (!shared || value.revision >= shared.revision) shared = value
    return true
  }
  async function flush() {
    if (!shared || sending || disposed || !pending.length) return
    sending = true
    try {
      while (pending.length && !disposed) {
        const res = await fetch(hubUrl('/api/sessions/sync'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pending[0]), signal: AbortSignal.timeout(10000) })
        if (!res.ok) {
          if (res.status === 400) { pending.shift(); save(); render(); refresh() }
          throw new Error('会话状态尚未同步，联网后会自动重试。')
        }
        const result = await res.json()
        if (disposed) return
        if (!accept(result.shared)) throw new Error('会话状态同步失败，稍后自动重试。')
        pending.shift(); save(); render()
        if (!result.accepted) refresh()
      }
      error('')
    } catch {
      if (!disposed) error('会话状态尚未同步，联网后会自动重试。')
    } finally { sending = false }
  }
  return {
    get enabled() { return shared !== null },
    receive(value) {
      if (!accept(value)) return
      if (!migrated) {
        // Only the first device seeds ordering. Later devices cannot overwrite it
        // with an old local snapshot. Matching legacy reads can safely be merged.
        if (shared.layout === null) pending.push({ type: 'initialize', layout: normalizeLayout(legacyLayout) })
        for (const session of sessions()) if (legacyRead[session.name] && legacyRead[session.name] === session.activity?.completed &&
          shared.read[session.name]?.completed !== legacyRead[session.name]) {
          pending.push({ type: 'read', name: session.name, createdAt: session.createdAt, completed: legacyRead[session.name] })
        }
        migrated = true; save()
        try { localStorage.setItem(migrationKey, '1') } catch {}
      }
      render(); void flush()
    },
    enqueue(op) { pending.push(op); save(); render(); void flush() },
    dispose() { disposed = true },
  }
}
