function summarize(snapshot, task) {
  const config = snapshot.configuration || snapshot.route || {}
  const done = snapshot.status === 'SUBMITTED' || !!snapshot.localResult || !!snapshot.result
  const waiting = !done && (!!snapshot.finishIntent || !!snapshot.finishCommand || !!(task && task.finish) || snapshot.localState && snapshot.localState.status === 'SUBMITTED')
  return { id: snapshot.id, questionBankId: snapshot.questionBankId, title: snapshot.title || '', createdAt: snapshot.createdAt,
    status: snapshot.status === 'CANCELLED' ? 'CANCELLED' : done ? 'SUBMITTED' : waiting || snapshot.status === 'WAITING' ? 'WAITING' : 'IN_PROGRESS',
    feedback: snapshot.feedback || config.feedback || '', mode: snapshot.mode || config.mode || '',
    questionCount: snapshot.questionCount || config.count || snapshot.items && snapshot.items.length || 0 }
}
function merge(remoteItems, localItems) {
  const byId = new Map(remoteItems.map(item => [item.id, summarize(item)]))
  localItems.forEach(item => {
    const local = summarize(item), server = byId.get(local.id)
    const merged = Object.assign({}, server, local)
    if (server && server.status === 'CANCELLED') merged.status = 'CANCELLED'
    else if ((server && server.status === 'SUBMITTED') || local.status === 'SUBMITTED') merged.status = 'SUBMITTED'
    else if ((server && server.status === 'WAITING') || local.status === 'WAITING') merged.status = 'WAITING'
    if (!merged.title && server) merged.title = server.title
    if (!merged.questionCount && server) merged.questionCount = server.questionCount
    byId.set(local.id, merged)
  })
  return Array.from(byId.values()).filter(item => item.status !== 'CANCELLED').sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
}
function openRecord(item) {
  if (item.status === 'WAITING') return { type: 'toast', title: '练习记录已保存在本机，正在恢复' }
  return { type: 'navigate', url: `/page/practice/index?sessionId=${encodeURIComponent(item.id)}${item.status === 'IN_PROGRESS' ? '' : '&review=1'}` }
}
module.exports = { summarize, merge, openRecord }
