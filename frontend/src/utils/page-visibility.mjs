// Android reports Activity visibility; ordinary browsers use Page Visibility.
let nativeVisible
export function receiveVisibility(event) {
  if (event?.type === 'hub:visibility') nativeVisible = event.detail?.visible === true
}
export const pageHidden = () => nativeVisible === undefined ? document.hidden : !nativeVisible
