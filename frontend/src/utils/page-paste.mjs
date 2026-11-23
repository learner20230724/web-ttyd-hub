// A dialog or another editable field owns its clipboard operation.
export function pageOwnsPaste(event, ...allowedFields) {
  return !event.defaultPrevented &&
    !document.querySelector('dialog[open], .modal-overlay, [role="dialog"][aria-modal="true"]') &&
    (allowedFields.includes(event.target) || !event.target?.closest?.('input, textarea, [contenteditable], dialog, [role="dialog"]'))
}
