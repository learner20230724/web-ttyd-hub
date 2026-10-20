import { basePath } from './base.mjs'
import { normalizeLayout } from './session-layout.mjs'

// Origins are isolated by the browser; separate Hub mounts on the same origin
// also need separate keys. Keep the original root keys during the upgrade.
export const scopedStorageKey = key => basePath ? `${key}:${basePath}` : key
export const METADATA_KEY = scopedStorageKey('web-ttyd-hub.session-metadata.v1')
const MAX_BYTES = 2 * 1024 * 1024
const text = (value, limit = 2048) => typeof value === 'string' && value.length <= limit ? value : null
const record = value => value && typeof value === 'object' && !Array.isArray(value)

// Persist only fields needed to reopen the reader/sidebar. Do not copy server
// response objects wholesale (process details, credentials and quota do not
// belong in a navigation snapshot).
export function normalizeMetadata(value) {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > 2000) return null
  const names = new Set(), sessions = []
  for (const raw of value.sessions) {
    if (!record(raw) || !text(raw.name, 512) || !text(raw.createdAt, 128) || names.has(raw.name)) continue
    names.add(raw.name)
    const session = { name: raw.name, createdAt: raw.createdAt, status: raw.status === 'running' ? 'running' : 'stopped' }
    for (const key of ['displayName', 'shell', 'cwd', 'archivedAt', 'expiresAt', 'codexThreadId', 'resumeThreadId']) {
      if (raw[key] === null || text(raw[key])) session[key] = raw[key]
    }
    if (record(raw.activity)) {
      const activity = {}
      for (const key of ['available', 'detected', 'busy']) if (typeof raw.activity[key] === 'boolean') activity[key] = raw.activity[key]
      for (const key of ['phase', 'completed', 'source', 'startedAt', 'updatedAt']) {
        if (raw.activity[key] === null || text(raw.activity[key])) activity[key] = raw.activity[key]
      }
      if (raw.activity.error) activity.error = true
      session.activity = activity
    }
    sessions.push(session)
  }
  const read = Object.create(null)
  for (const session of sessions) {
    const marker = value.read?.[session.name]
    if (text(marker)) read[session.name] = marker
  }
  const selected = sessions.find(s => s.name === value.selection?.name && s.createdAt === value.selection?.createdAt && !s.archivedAt)
  const layout = normalizeLayout(value.layout)
  layout.order = layout.order.filter(name => names.has(name))
  layout.pinned = layout.pinned.filter(name => names.has(name))
  const shells = Array.isArray(value.shells) ? value.shells.slice(0, 100).filter(s => record(s) && text(s.id, 128) && text(s.name, 256))
    .map(s => ({ id: s.id, name: s.name })) : []
  return { version: 1, savedAt: Number.isFinite(value.savedAt) ? value.savedAt : 0, sessions, read, layout, shells,
    platform: text(value.platform, 128) || '', selection: selected ? { name: selected.name, createdAt: selected.createdAt } : null }
}

export function loadMetadata(storage, key = METADATA_KEY) {
  try {
    storage ??= globalThis.localStorage
    const json = storage?.getItem(key)
    if (!json || json.length > MAX_BYTES / 2) return null
    return normalizeMetadata(JSON.parse(json))
  } catch { return null }
}

export function saveMetadata(value, storage, key = METADATA_KEY) {
  try {
    storage ??= globalThis.localStorage
    const snapshot = normalizeMetadata({ ...value, version: 1, savedAt: Date.now() })
    if (!snapshot) return false
    const json = JSON.stringify(snapshot)
    if (json.length * 2 > MAX_BYTES) return false
    storage?.setItem(key, json)
    return Boolean(storage)
  } catch { return false }
}
