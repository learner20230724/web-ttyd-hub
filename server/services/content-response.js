const { createHash } = require('node:crypto');
const strongEtag = /^"[a-f0-9]{64}"$/;

function createContentResponse({ maxBytes = 16 * 1024 * 1024, maxScopes = 64, maxVersions = 4,
  ttl = 10 * 60 * 1000, now = Date.now } = {}) {
  // This cache belongs to one router/manager. A baseline is never looked up by
  // its hash alone: the session generation, reading mode and credentials must
  // match too. Only content is retained, never the credentials themselves.
  const scopes = new Map();
  let bytes = 0;
  function forget(key) {
    const versions = scopes.get(key);
    if (!versions) return;
    for (const entry of versions.values()) bytes -= entry.bytes;
    scopes.delete(key);
  }
  function expire() {
    const oldest = now() - ttl;
    for (const [key, versions] of scopes) {
      for (const [etag, entry] of versions) if (entry.used < oldest) {
        bytes -= entry.bytes; versions.delete(etag);
      }
      if (!versions.size) scopes.delete(key);
    }
  }
  function remember(key, etag, json) {
    const size = json.length * 2;
    if (size > maxBytes) return;
    let versions = scopes.get(key);
    if (!versions) versions = new Map();
    scopes.delete(key); scopes.set(key, versions);
    const previous = versions.get(etag);
    if (previous) bytes -= previous.bytes;
    versions.delete(etag); versions.set(etag, { json, bytes:size, used:now() }); bytes += size;
    while (versions.size > maxVersions) {
      const [oldest, entry] = versions.entries().next().value;
      versions.delete(oldest); bytes -= entry.bytes;
    }
    while (scopes.size > maxScopes || bytes > maxBytes) forget(scopes.keys().next().value);
  }
  return function contentResponse(req, res, data, scope) {
    // Transient timestamps and activity lamps do not change the actual text.
    const { capturedAt, activity, ...content } = data;
    const json = JSON.stringify(content);
    const etag = '"' + createHash('sha256').update(json).digest('hex') + '"';
    res.set('Cache-Control', 'no-store');
    res.set('ETag', etag);
    const matches = (req.headers['if-none-match'] || '').split(',').map(x => x.trim());
    // Callers without an explicit resource/generation scope keep the legacy
    // conditional response behavior, but cannot participate in delta caching.
    let key;
    if (typeof scope === 'string' && scope) {
      const credentials = createHash('sha256').update(JSON.stringify([
        req.headers.authorization || '', req.headers.cookie || '',
      ])).digest('hex');
      key = JSON.stringify([scope, credentials]);
      expire();
    }
    if (matches.includes(etag)) {
      if (key) remember(key, etag, json);
      return res.status(304).end();
    }
    let patch;
    if (key && req.headers['x-ttyd-delta'] === 'fields-v1') {
      const versions = scopes.get(key);
      const base = matches.find(value => strongEtag.test(value) && versions?.has(value));
      if (base) {
        const old = JSON.parse(versions.get(base).json), next = JSON.parse(json);
        const splices = Object.create(null), set = Object.create(null), remove = [];
        for (const field of Object.keys(next)) {
          const replacement = JSON.stringify(next[field]);
          if (!Object.hasOwn(old, field)) { set[field] = next[field]; continue; }
          const previous = JSON.stringify(old[field]);
          if (previous === replacement) continue;
          let start = 0, suffix = 0;
          while (start < previous.length && start < replacement.length && previous[start] === replacement[start]) start++;
          while (suffix < previous.length - start && suffix < replacement.length - start &&
            previous[previous.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]) suffix++;
          const splice = { start, deleteCount:previous.length - start - suffix,
            insert:replacement.slice(start, replacement.length - suffix) };
          // Terminal snapshots contain both plain text and ANSI. Patch each
          // field independently so appending one line never resends the other.
          if (Buffer.byteLength(JSON.stringify(splice)) + 16 < Buffer.byteLength(replacement)) splices[field] = splice;
          else set[field] = next[field];
        }
        for (const field of Object.keys(old)) if (!Object.hasOwn(next, field)) remove.push(field);
        // Hashes cover JSON key order too. Include the target order so source
        // transitions and inserted fields can be reconstructed exactly.
        patch = { delta: { format:'fields-v1', base, etag, keys:Object.keys(next), splices, set, remove } };
        // UTF-16 offsets match browser String.slice, including emoji. Compare
        // actual UTF-8 response bytes so a patch never increases wire traffic.
        if (Buffer.byteLength(JSON.stringify(patch)) + 64 >= Buffer.byteLength(JSON.stringify(data))) patch = null;
      }
    }
    if (key) remember(key, etag, json);
    return res.json(patch || data);
  };
}
module.exports = createContentResponse();
module.exports.create = createContentResponse;
