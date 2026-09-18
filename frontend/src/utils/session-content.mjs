// Raw text only on disk; derived HTML is always sanitized again by the renderer.
const memory = new Map(), pending = new Map(), loads = new Map()
const MEMORY_LIMIT = 64 * 1024 * 1024, DISK_LIMIT = 128 * 1024 * 1024
let database, liveSessions = null
export const contentKey = (session, view) => JSON.stringify([session.name, session.createdAt || '', view])
const allowed = entry => !liveSessions || liveSessions.get(entry.sessionId) === entry.generation
function openDB() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (!database) database = new Promise(resolve => {
    const req = indexedDB.open('ttyd-hub-content-v1', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('content', { keyPath:'key' })
      req.result.createObjectStore('metadata', { keyPath:'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = req.onblocked = () => resolve(null)
  })
  return database
}
function remember(entry) {
  memory.delete(entry.key); memory.set(entry.key, entry)
  let bytes = [...memory.values()].reduce((total, item) => total + item.bytes, 0)
  for (const [key, item] of memory) {
    if (bytes <= MEMORY_LIMIT || memory.size === 1) break
    bytes -= item.bytes; memory.delete(key)
  }
  return entry
}
async function persist(entry) {
  try {
    const db = await openDB(); if (!db || !allowed(entry) || entry.bytes > DISK_LIMIT) return
    const tx = db.transaction(['content','metadata'], 'readwrite')
    const content = tx.objectStore('content'), meta = tx.objectStore('metadata')
    // Do not serialize any view's derived HTML or scrolling state.
    content.put(entry)
    meta.put({ key:entry.key, sessionId:entry.sessionId, generation:entry.generation, bytes:entry.bytes, used:entry.used })
    const request = meta.getAll()
    request.onsuccess = () => {
      const items = request.result.sort((a,b) => a.used - b.used)
      let bytes = items.reduce((sum, item) => sum + item.bytes, 0)
      for (const item of items) {
        if (bytes <= DISK_LIMIT) break
        content.delete(item.key); meta.delete(item.key); bytes -= item.bytes
      }
    }
    tx.onerror = () => {} // Storage/quota failure must never block a live terminal.
  } catch {}
}
export function peekContent(session, view) {
  const entry = memory.get(contentKey(session, view))
  if (!entry || !allowed(entry)) return null
  entry.used = Date.now(); return remember(entry)
}
export async function loadContent(session, view) {
  const cached = peekContent(session, view); if (cached) return cached
  const key = contentKey(session, view)
  if (loads.has(key)) return loads.get(key)
  const task = (async () => {
    try {
      const db = await openDB(); if (!db) return null
      const entry = await new Promise(resolve => {
        const req = db.transaction('content').objectStore('content').get(key)
        req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null)
      })
      if (!entry || !allowed(entry) || !entry.data || typeof entry.bytes !== 'number') return null
      // A network response may have arrived while the database was opening.
      return peekContent(session, view) || remember(entry)
    } catch { return null }
    finally { loads.delete(key) }
  })()
  loads.set(key, task); return task
}
export async function fetchContent(session, view, { mobile = true } = {}) {
  const key = contentKey(session, view)
  if (pending.has(key)) return pending.get(key)
  const task = (async () => {
    const cached = await loadContent(session, view)
    const path = view === 'answer' ? 'mobile' : mobile ? 'mobile?view=full' : 'history'
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.name)}/${path}`, {
        signal:controller.signal, cache:'no-store', headers:cached?.etag ? { 'If-None-Match':cached.etag } : {}
      })
      if (response.status === 304 && cached) return cached
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '读取失败')
      delete data.capturedAt; delete data.activity
      const etag = response.headers.get('ETag')
      if (cached && ((etag && cached.etag === etag) || (!etag && JSON.stringify(cached.data) === JSON.stringify(data)))) return cached
      const entry = { key, sessionId:session.name, generation:session.createdAt || '', data, etag, used:Date.now(), bytes:JSON.stringify(data).length * 2 }
      if (!allowed(entry)) throw new Error('会话已删除')
      remember(entry); void persist(entry); return entry
    } finally { clearTimeout(timeout); pending.delete(key) }
  })()
  pending.set(key, task); return task
}
export async function pruneContent(sessions) {
  if (liveSessions && liveSessions.size === sessions.length && sessions.every(s => liveSessions.get(s.name) === (s.createdAt || ''))) return
  liveSessions = new Map(sessions.map(s => [s.name, s.createdAt || '']))
  for (const [key, entry] of memory) if (!allowed(entry)) memory.delete(key)
  try {
    const db = await openDB(); if (!db) return
    const tx = db.transaction(['content','metadata'],'readwrite'), meta = tx.objectStore('metadata')
    const req = meta.getAll()
    req.onsuccess = () => { for (const entry of req.result) if (!allowed(entry)) { meta.delete(entry.key); tx.objectStore('content').delete(entry.key) } }
  } catch {}
}
