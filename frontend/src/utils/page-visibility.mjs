// Latest lifecycle evidence wins; native foreground can override a stale
// WebView hidden flag until that browser flag actually changes.
let nativeVisible, owner, lastHidden
function observeDocument() {
  if (owner !== document) { owner = document; nativeVisible = undefined; lastHidden = document.hidden }
  if (lastHidden !== document.hidden) { lastHidden = document.hidden; nativeVisible = undefined }
}
export function receiveVisibility(event) {
  observeDocument()
  if (event?.type === 'hub:visibility') nativeVisible = event.detail?.visible === true
  else if (['focus', 'pageshow', 'visibilitychange'].includes(event?.type) && !document.hidden) nativeVisible = true
  else if (event?.type === 'visibilitychange' && document.hidden) nativeVisible = false
}
export const pageHidden = () => { observeDocument(); return nativeVisible === undefined ? document.hidden : !nativeVisible }
