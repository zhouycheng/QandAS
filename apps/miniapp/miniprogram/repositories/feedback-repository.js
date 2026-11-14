const transport = require('./api-transport.js')
const authRepository = require('./auth-repository.js')
const paths = { question: '/me/question-feedback', course: '/me/course-requests' }

function createFeedbackRepository(storage, http) {
  const api = http || transport
  const owner = authRepository.getAuth(storage)
  let pending = null
  const reads = new Map()
  function current() {
    const auth = authRepository.getAuth(storage)
    if (!owner.token || auth.token !== owner.token || auth.userId !== owner.userId) throw new Error('请重新登录后查看反馈')
  }
  async function request(method, kind, body, key, suffix, shouldSend) {
    current()
    if (!paths[kind]) throw new Error('请选择反馈类型')
    const result = await api.request(method, paths[kind] + (suffix || ''), body, { token: owner.token, idempotencyKey: key, shouldSend: () => authRepository.getAuth(storage).token === owner.token && (!shouldSend || shouldSend()) })
    current()
    if (!result.ok) throw new Error(result.reason || '反馈请求失败，请重试')
    return result.data
  }
  return {
    list(kind, page) { return request('GET', kind, { page, pageSize: 20 }) },
    async acknowledge(kind, items, shouldSend) {
      const body = { items: items.map(item => ({ id: item.id, version: item.version })).sort((a, b) => a.id.localeCompare(b.id)) }
      const fingerprint = JSON.stringify([kind, body])
      if (!reads.has(fingerprint)) reads.set(fingerprint, transport.uuid())
      const result = await request('PUT', kind, body, reads.get(fingerprint), '/read', shouldSend)
      if (!result || result.acknowledgedCount !== body.items.length) throw new Error('反馈已读状态保存失败')
      reads.delete(fingerprint)
      const remote = require('./remote-data-repository.js')
      remote.invalidateFeedbackSummary(storage)
      remote.refreshFeedbackSummary(storage).catch(() => {})
      return result
    },
    async submit(kind, body) {
      const fingerprint = JSON.stringify([kind, body])
      if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, key: transport.uuid() }
      const intent = pending
      const value = await request('POST', kind, body, intent.key)
      if (pending === intent) pending = null
      return value
    }
  }
}
module.exports = { createFeedbackRepository }
