// Clipboard items can only be read during the paste event. Keep the actual
// File objects, including multiple files, before any asynchronous work.
export function pastedFiles(clipboard) {
  const files = Array.from(clipboard?.files || [])
  return files.length ? files : Array.from(clipboard?.items || [], item => item.getAsFile?.()).filter(Boolean)
}

async function isSupportedImage(file) {
  if (file.type && file.type !== 'application/octet-stream') return /^image\/(png|jpe?g|gif|webp)$/i.test(file.type)
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const signature = String.fromCharCode(...bytes)
  return signature.startsWith('\x89PNG\r\n\x1a\n') || signature.startsWith('\xff\xd8\xff') ||
    /^GIF8[79]a/.test(signature) || (signature.startsWith('RIFF') && signature.slice(8) === 'WEBP')
}

export async function splitPastedFiles(files) {
  const imageFlags = await Promise.all(files.map(isSupportedImage))
  return {
    images: files.filter((_, i) => imageFlags[i]),
    documents: files.filter((_, i) => !imageFlags[i]),
  }
}
