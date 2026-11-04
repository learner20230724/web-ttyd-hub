// Epochs identify server lifetimes, revisions order observations within one.
export function createStateOrder() {
  let epoch = null
  const retired = new Set()
  return {
    confirm(next) {
      if (!next) return !epoch
      if (retired.has(next)) return false
      if (epoch && epoch !== next) retired.add(epoch)
      epoch = next
      return true
    },
    accepts(value, current) {
      if (epoch && value.stateEpoch !== epoch) return false
      if (value.stateEpoch && (!Number.isSafeInteger(value.activityRevision) || value.activityRevision < 0)) return false
      return !current || value.stateEpoch !== current.stateEpoch || !value.stateEpoch || value.activityRevision >= current.activityRevision
    },
    get epoch() { return epoch },
  }
}
