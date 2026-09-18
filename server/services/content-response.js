const { createHash } = require('node:crypto');
function contentResponse(req, res, data) {
  // Transient timestamps and activity lamps do not change the actual text.
  const { capturedAt, activity, ...content } = data;
  const etag = '"' + createHash('sha256').update(JSON.stringify(content)).digest('hex') + '"';
  res.set('Cache-Control', 'no-store');
  res.set('ETag', etag);
  if ((req.headers['if-none-match'] || '').split(',').map(x => x.trim()).includes(etag)) return res.status(304).end();
  return res.json(data);
}
module.exports = contentResponse;
