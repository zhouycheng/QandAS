const http = require('../repositories/http-gateway.js')
const auth = require('../repositories/auth-repository.js')
const online = require('../repositories/online-practice.js')
const remote = require('../repositories/remote-data-repository.js')
const { merge, summarize, openRecord } = require('../models/practice-record-summary.js')
function records(remoteItems, localItems) {
  return merge(remoteItems, localItems).map(item => {
    const bank = remote.getBankMeta(item.questionBankId)
    const state = item.status === 'SUBMITTED' ? 'ended' : item.status === 'WAITING' ? 'waiting' : 'active'
    return { id: item.id, status: item.status, feedback: item.feedback, title: item.title || bank && bank.name || '题库练习', state,
      statusText: { ended: '已完成', waiting: '练习记录恢复中', active: '进行中' }[state], review: state !== 'active',
      countText: `${item.questionCount} 题`, timeText: item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }) : '',
      feedbackText: { IMMEDIATE: '即时反馈', AFTER_FINISH: '交卷后反馈' }[item.feedback] || '',
      actionText: state === 'active' ? '继续答题' : state === 'ended' || item.feedback === 'IMMEDIATE' ? '回看作答' : '查看记录',
      modeText: { order: '顺序练习', practice: '随机练习', test: '模拟考试', view: '背题' }[item.mode] || '练习' }
  })
}

class PracticeRecordsViewModel {
  constructor(storage) { this.storage = storage; this.remoteItems = []; this.page = 0; this.visiblePage = 0; this.owner = auth.getAuth(storage).userId }
  local() {
    const runtime = online.current(), identity = auth.getAuth(this.storage)
    if (!runtime || !identity.loggedIn || identity.userId !== this.owner) return []
    runtime.identity()
    const key = `qandaPracticeRecords:${this.owner}`
    let entries = this.storage.get(key)
    if (!this.indexChecked) {
      const keys = this.storage.keysStrict ? this.storage.keysStrict() : this.storage.keys ? this.storage.keys() : []
      const ids = new Set(runtime.queue.sessionIds().concat(keys.filter(key => key.startsWith(`qandaOnline:${this.owner}:`) && key.split(':').length === 3).map(key => key.split(':')[2])))
      entries = entries || {}
      for (const id of ids) {
        const snapshot = runtime.get(id)
        if (snapshot) entries[id] = summarize(snapshot, runtime.queue.get(id))
      }
      this.storage.set(key, entries)
      this.indexChecked = true
    }
    return Object.values(entries || {})
  }
  view() { return records(this.remoteItems, this.local()).slice(0, Math.max(1, this.visiblePage) * 20) }
  open(item) { return openRecord(item) }
  async load(reset) {
    const identity = auth.getAuth(this.storage)
    if (!identity.loggedIn || identity.userId !== this.owner) return { items: [], error: '请登录原账号后查看练习记录', hasMore: false }
    this.visiblePage = reset ? 1 : this.visiblePage + 1
    if (reset) this.page = 0
    const page = this.page + 1
    const result = await http.request('GET', `/me/recent-learning?page=${page}&pageSize=20&deviceId=${auth.deviceId(this.storage)}`, null, { token: identity.token })
    if (auth.getAuth(this.storage).userId !== this.owner) return { items: [], error: '账号已切换', hasMore: false }
    if (result.ok) { this.page = page; this.remoteItems = (page === 1 ? [] : this.remoteItems).concat(result.data.items); this.total = result.data.total }
    return { items: this.view(), error: result.ok ? '' : result.reason || '暂时无法读取服务器记录，本机记录已保留', hasMore: this.remoteItems.length < (this.total || 0) || merge(this.remoteItems, this.local()).length > this.visiblePage * 20 }
  }
}
module.exports = { PracticeRecordsViewModel, records }
