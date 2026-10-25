import { hubUrl } from './base.mjs'
import { normalizeLayout, moveSession } from './session-layout.mjs'
import { scopedStorageKey } from './session-metadata.mjs'
import { untilAbort } from './request-deadline.mjs'

// One outbox per tab/WebView, retained through reload. Confirmed state always
// comes from the Hub; local caches only seed the first upgrade.
export function createSessionSync({ sessions, legacyRead, legacyReadRevisions = {}, legacyLayout, preview, apply, confirmed, error, refresh }) {
  const migrationKey = scopedStorageKey('web-ttyd-hub.shared-migrated.v1')
  const pendingKey = scopedStorageKey('web-ttyd-hub.shared-pending.v1')
  let shared = null, sending = null, disposed = false, migrated = false, pending = []
  try { migrated = localStorage.getItem(migrationKey) === '1' } catch {}
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingKey))
    if (Array.isArray(saved)) pending = saved.slice(0, 1000).filter(op => op && ['read', 'pin', 'move', 'initialize'].includes(op.type))
  } catch {}
  const save = () => { try { sessionStorage.setItem(pendingKey, JSON.stringify(pending)) } catch {} }
  function render() {
    const source = shared || preview
    if (!source || disposed) return
    const list = sessions(), read = Object.create(null), readRevisions = Object.create(null)
    for (const session of list) {
      const marker = source.read[session.name]
      if (marker?.createdAt === session.createdAt) {
        read[session.name] = marker.completed
        if (marker.contentRevision) readRevisions[session.name] = marker.contentRevision
      }
    }
    let layout = normalizeLayout(source.layout)
    for (const op of pending) {
      if (op.type === 'initialize') {
        if (source.layout === null) layout = normalizeLayout(op.layout)
        continue
      }
      const session = list.find(s => s.name === op.name && s.createdAt === op.createdAt && !s.archivedAt)
      if (!session) continue
      if (op.type === 'read') {
        const revision = session.activity?.contentRevision
        if (session.activity?.completed !== op.completed || revision && op.contentRevision !== revision ||
          read[op.name] === op.completed && (!op.contentRevision || readRevisions[op.name] === op.contentRevision)) continue
        const bindLegacy = read[op.name] === op.completed && !readRevisions[op.name]
        read[op.name] = op.completed
        if (op.contentRevision) readRevisions[op.name] = op.contentRevision
        else delete readRevisions[op.name]
        if (!bindLegacy) layout.order = [op.name, ...layout.order.filter(name => name !== op.name)]
      } else if (op.type === 'pin') {
        if (layout.pinned.includes(op.name) === op.pinned) continue
        layout.pinned = op.pinned ? [...layout.pinned, op.name] : layout.pinned.filter(name => name !== op.name)
        layout.order = [op.name, ...layout.order.filter(name => name !== op.name)]
      } else if (list.some(s => s.name === op.target && s.createdAt === op.targetCreatedAt && !s.archivedAt)) {
        layout = moveSession(list, layout, op.name, op.target, op.after)
      }
    }
    apply({ read, readRevisions, layout })
  }
  function accept(value) {
    if (!value || !Number.isSafeInteger(value.revision) || !value.read) return false
    if (!shared || value.revision >= shared.revision) {
      shared = value
      // Persist acknowledged state, including successful mutation responses.
      // The optimistic render below can still contain unconfirmed outbox ops.
      confirmed?.(shared)
    }
    return true
  }
  async function flush() {
    if (!shared || sending || disposed || !pending.length) return
    const request = new AbortController()
    sending = request
    const current = () => !disposed && sending === request && !request.signal.aborted
    try {
      while (pending.length && current()) {
        const op = pending[0]
        const session = op.type === 'read' && sessions().find(value => value.name === op.name && value.createdAt === op.createdAt)
        if (session?.activity?.contentRevision && (session.activity.completed !== op.completed || session.activity.contentRevision !== op.contentRevision)) {
          // An old queue or legacy migration cannot turn an unseen newer
          // answer into a read just because the turn's completed token matches.
          pending.shift(); save(); render(); continue
        }
        let res
        const timeout = setTimeout(() => request.abort(), 10000)
        try {
          res = await untilAbort(fetch(hubUrl('/api/sessions/sync'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pending[0]), signal: request.signal }), request.signal)
          if (!current()) return
          if (res.ok) {
            const result = await untilAbort(res.json(), request.signal)
            if (!current()) return
            if (!accept(result.shared)) throw new Error('会话状态同步失败，稍后自动重试。')
            pending.shift(); save(); render()
            if (!result.accepted) refresh()
          }
        } finally { clearTimeout(timeout) }
        if (!res.ok) {
          if (res.status === 400) { pending.shift(); save(); render(); refresh() }
          throw new Error('会话状态尚未同步，联网后会自动重试。')
        }
      }
      if (current()) error('')
    } catch {
      if (!disposed && sending === request) error('会话状态尚未同步，联网后会自动重试。')
    } finally { if (sending === request) sending = null }
  }
  // Replay the durable outbox over cached state immediately. A preview never
  // enables network writes or calls confirmed; the live snapshot must do that.
  if (preview) render()
  return {
    get enabled() { return shared !== null },
    receive(value) {
      if (!accept(value)) return false
      if (!migrated) {
        // Only the first device seeds ordering. Later devices cannot overwrite it
        // with an old local snapshot. Matching legacy reads can safely be merged.
        if (shared.layout === null) pending.push({ type: 'initialize', layout: normalizeLayout(legacyLayout) })
        for (const session of sessions()) if (legacyRead[session.name] && legacyRead[session.name] === session.activity?.completed) {
          const revision = legacyReadRevisions[session.name]
          if (session.activity?.contentRevision && revision !== session.activity.contentRevision) continue
          const marker = shared.read[session.name]
          if (marker?.completed === legacyRead[session.name] && (!revision || marker.contentRevision === revision)) continue
          pending.push({ type: 'read', name: session.name, createdAt: session.createdAt, completed: legacyRead[session.name],
            ...(revision ? { contentRevision: revision } : {}) })
        }
        migrated = true; save()
        try { localStorage.setItem(migrationKey, '1') } catch {}
      }
      render(); void flush()
      return true
    },
    enqueue(op) { pending.push(op); save(); render(); void flush() },
    retry() { sending?.abort(); sending = null; void flush() },
    dispose() { disposed = true; sending?.abort() },
  }
}
