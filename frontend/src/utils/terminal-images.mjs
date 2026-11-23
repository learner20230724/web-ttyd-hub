import { hubUrl } from './base.mjs'
import { untilAbort } from './request-deadline.mjs'

// Paste image references into the live composer without submitting the prompt.
export async function insertTerminalImages(session, images, signal) {
  const response = await untilAbort(fetch(hubUrl(`/api/sessions/${encodeURIComponent(session.name)}/input`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TTYD-Generation': session.createdAt || '',
      'X-TTYD-Thread': session.codexThreadId || session.resumeThreadId || '',
    },
    body: JSON.stringify({ images: images.map(image => image.id), key: null }),
    signal,
  }), signal)
  const data = await untilAbort(response.json(), signal)
  if (!response.ok) throw new Error(data.error || '图片未能加入终端')
  return data
}
