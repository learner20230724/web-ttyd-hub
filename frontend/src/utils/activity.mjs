// One vocabulary for the session list and the mobile reader. Completion is a
// successful turn outcome; busy=false alone is never evidence of success.
export function activityState(session, read = {}) {
  if (session.status !== 'running') return 'idle'
  const a = session.activity || {}
  if (a.phase === 'waiting') return 'waiting'
  if (a.phase === 'error' || (a.error && !a.busy)) return 'error'
  if (a.phase === 'interrupted') return 'interrupted'
  if (a.busy) return 'busy'
  if (a.phase === 'unknown' || a.available === false) return session.shell === 'codex' || a.detected ? 'unknown' : 'idle'
  if (a.completed && read[session.name] !== a.completed) return 'unread'
  return 'idle'
}
export function activityPresentation(session, read = {}, connectionIssue = false) {
  if (connectionIssue) return { state: 'unknown', label: '连接中断', detail: '正在重新连接，任务状态暂未更新。草稿会保留。' }
  if (session.status !== 'running') return { state: 'idle', label: '已停止连接', detail: '终端入口已停止，后台任务可能仍在运行。' }
  const state = activityState(session, read), a = session.activity || {}
  const labels = {
    working: ['工作中', '任务仍在进行，完成后会标记为绿色。'],
    thinking: ['思考中', 'Codex 正在思考，暂时没有新回复。'],
    responding: ['回复中', '正在生成回复，任务尚未结束。'],
    executing: ['执行中', '正在执行命令或工具，可打开全文查看进展。'],
    retrying: ['正在重试', 'Codex 正在重试连接，当前任务尚未完成。'],
    waiting: ['等待你操作', '请查看全文中的问题或确认选项，用方向键和回车操作。'],
    error: ['执行出错', '本轮未成功完成，请打开全文查看原因。'],
    interrupted: ['已中断', '本轮已中断，可以输入补充要求继续。'],
    unread: ['已完成 · 未读', '本轮工作已完成，有新回复待查看。'],
    // Missing task telemetry is not a pending user action. Keep the original
    // neutral connection indicator; never infer a successful completion.
    unknown: ['已连接', '终端已连接。'],
  }
  const [label, detail] = labels[state === 'busy' ? a.phase in labels ? a.phase : 'working' : state]
    || (a.completed ? ['已完成 · 已读', '本轮工作已完成，可以继续发送新要求。']
      : a.available ? ['等待输入', '输入消息开始下一轮工作。'] : ['终端就绪', '输入命令，或打开全文查看终端。'])
  return { state, label, detail }
}
