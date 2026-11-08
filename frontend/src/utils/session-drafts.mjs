import { scopedStorageKey } from './session-metadata.mjs'
const storageKey = scopedStorageKey('web-ttyd-hub.drafts.v1')
export const draftKey = s => s ? JSON.stringify([s.name, s.createdAt || '', s.codexThreadId || s.resumeThreadId || '']) : ''
export function loadDrafts() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey))
    return new Map(Array.isArray(data) ? data.filter(([key, value]) => typeof key === 'string' && typeof value?.text === 'string' && Array.isArray(value.images)).slice(-100) : [])
  } catch { return new Map() }
}
export function persistDrafts(drafts) {
  try { localStorage.setItem(storageKey, JSON.stringify([...drafts].slice(-100))); return true } catch { return false }
}
