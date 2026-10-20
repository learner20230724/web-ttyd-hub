import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export const contentETag = data => `"${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(data))))}"`

// Verify the reconstructed representation, including property order. This also
// works on HTTP/WebViews where Web Crypto is not available in a secure context.
export function applyContentDelta(cached, delta, etag) {
  if (!cached || !object(cached.data) || !object(delta) || delta.format !== 'fields-v1' ||
      !cached.etag || delta.base !== cached.etag || delta.etag !== etag ||
      !Array.isArray(delta.keys) || new Set(delta.keys).size !== delta.keys.length ||
      delta.keys.some(key => typeof key !== 'string') || !object(delta.set) ||
      !object(delta.splices) || !Array.isArray(delta.remove)) throw Error('Invalid content delta')
  const result = Object.assign(Object.create(null), cached.data)
  for (const key of delta.remove) {
    if (typeof key !== 'string' || !own(result, key)) throw Error('Invalid removed field')
    delete result[key]
  }
  for (const [key, value] of Object.entries(delta.set)) result[key] = value
  for (const [key, splice] of Object.entries(delta.splices)) {
    if (!own(result, key) || own(delta.set, key) || !object(splice) ||
        !Number.isSafeInteger(splice.start) || !Number.isSafeInteger(splice.deleteCount) ||
        splice.start < 0 || splice.deleteCount < 0 || typeof splice.insert !== 'string') throw Error('Invalid content splice')
    const original = JSON.stringify(result[key])
    if (splice.start > original.length || splice.deleteCount > original.length - splice.start) throw Error('Content splice out of bounds')
    result[key] = JSON.parse(original.slice(0, splice.start) + splice.insert + original.slice(splice.start + splice.deleteCount))
  }
  if (Object.keys(result).length !== delta.keys.length || delta.keys.some(key => !own(result, key))) throw Error('Invalid content fields')
  const ordered = Object.create(null)
  for (const key of delta.keys) ordered[key] = result[key]
  if (contentETag(ordered) !== etag) throw Error('Content checksum mismatch')
  return ordered
}
