const api = require('./api-transport.js')
const auth = require('./auth-repository.js')
const remote = require('./remote-data-repository.js')
const MARKER = 'qandaErasedAccount:'
function clean(storage, id) {
  const runtime = require('./online-practice.js').current()
  if (runtime && runtime.userId === id && runtime.queue) runtime.queue.stop()
  const prefixes = ['qandaOnline:', 'qandaSync:v1:', 'qandaAnswer:v1:', 'qandaContent:', 'qandaContentLatest:'].map(prefix => prefix + id + ':')
  const exact = ['qandaReadCache:', 'qandaOnlineLast:', 'qandaOnlineCreate:', 'qandaPracticeRecords:', 'qandaOnlineCompleted:', 'qandaViewClosures:', 'qandaSyncCooldown:v1:'].map(prefix => prefix + id)
  const keys = storage.keysStrict ? storage.keysStrict() : storage.keys()
  keys.filter(key => exact.includes(key) || prefixes.some(prefix => key.startsWith(prefix))).forEach(key => storage.remove(key))
  const preview = storage.get('qandaScopePreview')
  if (preview && preview.context === id) storage.remove('qandaScopePreview')
  const marker = storage.get(MARKER + id)
  if (marker && marker.email) {
    const challenges = storage.get('qandaEmailChallenges') || {}
    Object.keys(challenges).filter(key => key.endsWith(':' + marker.email.toLowerCase())).forEach(key => delete challenges[key])
    storage.set('qandaEmailChallenges', challenges)
  }
  if (auth.getAuth(storage).userId === id) auth.clearAuth(storage)
  remote.bind(storage)
  storage.remove(MARKER + id)
}
function resumeCleanup(storage) {
  const keys = storage.keysStrict ? storage.keysStrict() : storage.keys()
  keys.filter(key => key.startsWith(MARKER) && /^[0-9a-f-]{36}$/i.test(key.slice(MARKER.length))).forEach(key => clean(storage, key.slice(MARKER.length)))
}
class AccountDeletionRepository {
  constructor(storage) { this.storage = storage; this.identity = auth.getAuth(storage); this.key = api.uuid() }
  assertIdentity() { if (!this.identity.token || auth.getAuth(this.storage).token !== this.identity.token) throw new Error('账号已切换，请重新进入') }
  async send(method, path, body, options) {
    const response = await api.request(method, path, body, Object.assign({ token: this.identity.token }, options))
    if (!response.ok) throw new Error(response.reason || '注销失败，请重试')
    return response.data
  }
  async load() {
    this.assertIdentity()
    const profile = await this.send('GET', '/me')
    this.assertIdentity()
    this.method = profile.isTestAccount ? 'TEST' : this.identity.provider === 'wechat' ? 'WECHAT' : 'EMAIL'
    return { method: this.method, email: profile.email || '' }
  }
  async issue() {
    this.assertIdentity()
    const challenge = await this.send('POST', '/me/email-challenges', { purpose: 'DELETE_ACCOUNT' }, { idempotencyKey: api.uuid() })
    this.assertIdentity(); this.challenge = challenge
    return challenge
  }
  async verify(value, wechatCode) {
    this.assertIdentity()
    const input = this.method === 'TEST' ? { loginCode: value } : this.method === 'WECHAT' ? { code: wechatCode }
      : { challengeId: this.challenge && this.challenge.id, code: value }
    const proof = await this.send('POST', '/me/deletion-confirmations', input)
    this.assertIdentity(); this.proof = proof.proof
  }
  async erase() {
    if (!this.erased) {
      this.assertIdentity()
      if (!this.proof) throw new Error('请先验证当前登录身份')
      await this.send('DELETE', '/me', { proof: this.proof, confirmed: true }, { token: '', idempotencyKey: this.key })
      this.erased = true
    }
    // Cleanup metadata lets interrupted local cleanup resume after verification credentials are gone.
    this.storage.set(MARKER + this.identity.userId, { email: this.identity.email })
    clean(this.storage, this.identity.userId)
    this.proof = ''
  }
}
module.exports = { AccountDeletionRepository, resumeCleanup, clean }
