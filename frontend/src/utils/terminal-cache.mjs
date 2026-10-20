const textFields = ['screen', 'normal', 'history', 'alternate', 'pending'];
const MAX_BYTES = 20 * 1024 * 1024;
const serializedSize = data => { try { return JSON.stringify(data).length; } catch { return Infinity; } };

// Cached escape sequences are rendered with query replies and stdin disabled.
// This only accepts the versioned, generation-scoped data written by this app.
export function terminalCache(data) {
  const snapshot = data?.snapshot;
  if (data?.version !== 1 || !validSnapshot(snapshot) || !Array.isArray(data.updates) || data.updates.length > 8192) return null;
  if (data.updates.some(item => typeof item !== 'string' || item.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item))) return null;
  const bytes = data.updates.reduce((sum, item) => sum + item.length, 0);
  if (bytes > MAX_BYTES || serializedSize(snapshot) > MAX_BYTES) return null;
  return { version: 1, snapshot, updates: data.updates.slice() };
}

export function validSnapshot(snapshot) {
  const meta = snapshot?.meta;
  return snapshot?.type === 'snapshot' && /^[a-f0-9]{64}$/.test(snapshot.digest || '') &&
    Number.isInteger(meta?.pane_width) && meta.pane_width >= 2 && meta.pane_width <= 500 &&
    Number.isInteger(meta?.pane_height) && meta.pane_height >= 2 && meta.pane_height <= 300 &&
    textFields.every(field => typeof snapshot[field] === 'string') &&
    snapshot.pending.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(snapshot.pending);
}

export function applyTerminalDelta(baseline, message) {
  if (message?.type !== 'snapshot-delta' || !validSnapshot(baseline) || message.base !== baseline.digest ||
      !message.changes || typeof message.changes !== 'object') throw new Error('Invalid terminal cache baseline');
  const snapshot = { ...baseline, meta: message.meta, digest: message.digest };
  for (const field of ['generation', 'completed']) if (Object.hasOwn(message, field)) snapshot[field] = message[field];
  for (const [field, splice] of Object.entries(message.changes)) {
    if (!textFields.includes(field) || !Array.isArray(splice) || splice.length !== 3) throw new Error('Invalid terminal cache patch');
    const [start, remove, insert] = splice, text = baseline[field];
    if (!Number.isInteger(start) || !Number.isInteger(remove) || start < 0 || remove < 0 ||
        start + remove > text.length || typeof insert !== 'string') throw new Error('Invalid terminal cache patch');
    snapshot[field] = text.slice(0, start) + insert + text.slice(start + remove);
  }
  if (!validSnapshot(snapshot)) throw new Error('Invalid terminal cache snapshot');
  return snapshot;
}

export function encodeTerminalBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(result);
}
export const decodeTerminalBytes = text => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
