import { hubUrl, basePath } from './base.mjs'
import { applyContentDelta } from './content-delta.mjs'
// Raw text only on disk; derived HTML is always sanitized again by the renderer.
const memory = new Map(), pending = new Map(), loads = new Map()
const MEMORY_LIMIT = 64 * 1024 * 1024, DISK_LIMIT = 128 * 1024 * 1024
const STORAGE_TIMEOUT = 500
const CONDITIONAL_WAIT = 75
let database, liveSessions = null
const databaseName = 'ttyd-hub-content-v1' + (basePath ? ':' + basePath : '')
export const contentKey = (session, view) => JSON.stringify([...(basePath ? [basePath] : []), session.name, session.createdAt || '', view])
const allowed = entry => !liveSessions || liveSessions.get(entry.sessionId) === entry.generation
function openDB() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (!database) database = new Promise(resolve => {
    let settled = false
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => finish(null), STORAGE_TIMEOUT)
    let req
    try { req = indexedDB.open(databaseName, 1) }
    catch { finish(null); return }
    req.onupgradeneeded = () => {
      req.result.createObjectStore('content', { keyPath:'key' })
      req.result.createObjectStore('metadata', { keyPath:'key' })
    }
    req.onsuccess = () => settled ? req.result.close() : finish(req.result)
    req.onerror = req.onblocked = () => finish(null)
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
export function saveContent(session, view, data, etag = null) {
  const entry = { key: contentKey(session, view), sessionId: session.name, generation: session.createdAt || '',
    data, etag, used: Date.now(), bytes: JSON.stringify(data).length * 2 }
  if (!allowed(entry)) return null
  remember(entry); void persist(entry); return entry
}
export async function loadContent(session, view) {
  const cached = peekContent(session, view); if (cached) return cached
  const key = contentKey(session, view)
  if (loads.has(key)) return loads.get(key)
  const task = (async () => {
    try {
      const db = await openDB(); if (!db) return null
      const entry = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), STORAGE_TIMEOUT)
        const req = db.transaction('content').objectStore('content').get(key)
        req.onsuccess = () => { clearTimeout(timer); resolve(req.result) }
        req.onerror = () => { clearTimeout(timer); resolve(null) }
      })
      if (!entry || entry.key !== key || entry.sessionId !== session.name || entry.generation !== (session.createdAt || '') ||
          !allowed(entry) || !entry.data || typeof entry.bytes !== 'number' || entry.bytes > DISK_LIMIT) return null
      // A network response may have arrived while the database was opening.
      return peekContent(session, view) || remember(entry)
    } catch { return null }
    finally { loads.delete(key) }
  })()
  loads.set(key, task); return task
}
export async function fetchContent(session, view, { mobile = true, fresh = false } = {}) {
  const key = contentKey(session, view)
  const previous = pending.get(key)
  if (previous && !fresh) return previous.task
  if (previous) previous.controller.abort()
  const job = { controller: new AbortController() }
  const { controller } = job
  const active = () => { if (controller.signal.aborted) throw controller.signal.reason || new Error('读取已取消') }
  const task = Promise.resolve().then(async () => {
    // Give a normal disk read a short chance to supply its ETag. A blocked DB
    // still cannot gate a live request; the renderer restores disk independently.
    let cached = peekContent(session, view)
    if (!cached && typeof indexedDB !== 'undefined') {
      let timer
      try { cached = await Promise.race([loadContent(session, view), new Promise(resolve => { timer = setTimeout(() => resolve(null), CONDITIONAL_WAIT) })]) }
      finally { clearTimeout(timer) }
    }
    active()
    const path = view === 'answer' ? 'mobile' : mobile ? 'mobile?view=full' : 'history'
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const url = hubUrl(`/api/sessions/${encodeURIComponent(session.name)}/${path}`)
      const headers = session.createdAt ? { 'X-TTYD-Generation':session.createdAt } : {}
      let data, etag
      for (let attempt = 0; attempt < 2; attempt++) {
        const conditional = attempt === 0 && cached?.etag
        const response = await fetch(url, { signal:controller.signal, cache:'no-store',
          headers: { ...headers, ...(conditional ? { 'If-None-Match':cached.etag, 'X-TTYD-Delta':'fields-v1' } : {}) } })
        active()
        if (response.status === 304) {
          if (conditional) return cached
          throw Error('读取失败：服务器未返回正文')
        }
        data = await response.json()
        active()
        if (!response.ok) throw new Error(data.error || '读取失败')
        etag = response.headers.get('ETag')
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('读取失败：无效正文')
        if (data.delta) {
          try {
            if (!conditional) throw Error('Missing content baseline')
            data = applyContentDelta(cached, data.delta, etag)
          } catch {
            if (attempt === 0) continue // One unconditional recovery, no bad baseline persisted.
            throw Error('读取失败：正文校验失败')
          }
        }
        break
      }
      delete data.capturedAt; delete data.activity
      if (cached && ((etag && cached.etag === etag) || (!etag && JSON.stringify(cached.data) === JSON.stringify(data)))) return cached
      const entry = saveContent(session, view, data, etag)
      if (!entry) throw new Error('会话已删除')
      return entry
    } finally { clearTimeout(timeout); if (pending.get(key) === job) pending.delete(key) }
  })
  job.task = task; pending.set(key, job); return task
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
