// Cancelling application work must not depend on a suspended transport or body
// reader acknowledging AbortSignal. Callers own the deadline and retry policy.
export function untilAbort(task, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', cancelled); callback(value)
    }
    const cancelled = () => finish(reject, signal.reason || new DOMException('读取已取消', 'AbortError'))
    signal.addEventListener('abort', cancelled, { once: true })
    Promise.resolve(task).then(value => finish(resolve, value), error => finish(reject, error))
    if (signal.aborted) cancelled()
  })
}
