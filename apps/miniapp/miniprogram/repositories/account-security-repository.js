const auth = require('./auth-repository.js')
const gateway = require('./http-gateway.js')
const remote = require('./remote-data-repository.js')

class AccountSecurityRepository {
  constructor(storage) {
    this.storage = storage
    this.token = auth.getAuth(storage).token
  }

  assertIdentity() {
    if (this.closed || !this.token || auth.getAuth(this.storage).token !== this.token) {
      throw Object.assign(new Error('登录状态已变化，请重新进入'), { code: 'SESSION_CHANGED' })
    }
  }

  async call(method, input, key) {
    this.assertIdentity()
    const response = await gateway[method](input, { token: this.token, idempotencyKey: key, shouldSend: () => auth.getAuth(this.storage).token === this.token })
    this.assertIdentity()
    if (!response.ok) throw Object.assign(new Error(response.reason || '请求失败，请重试'), { code: response.code, statusCode: response.statusCode, retryAfter: response.retryAfter })
    return response.data
  }

  async load() {
    this.assertIdentity()
    await remote.refreshProfile(this.storage, { force: true })
    this.assertIdentity()
    return remote.getProfile(this.storage)
  }

  issue(input, key) { return this.call('requestOwnEmailChallenge', input, key) }

  async verify(id, input) {
    this.assertIdentity()
    const response = await gateway.verifyOwnEmailChallenge(id, input, { token: this.token, shouldSend: () => auth.getAuth(this.storage).token === this.token })
    this.assertIdentity()
    if (!response.ok) throw Object.assign(new Error(response.reason), { code: response.code, retryAfter: response.retryAfter })
    return response.data
  }

  email(input, key) { return this.call('changeOwnEmail', input, key) }
  wechatCode() { this.assertIdentity(); return auth.requestWechatCode() }
  wechat(input, key) { return this.call('bindOwnWechat', input, key) }

  async refresh() {
    this.assertIdentity()
    await remote.refreshProfile(this.storage, { force: true })
    this.assertIdentity()
  }

  expire() {
    auth.expireAuth(this.storage, this.token)
    remote.bind(this.storage)
  }
  close() { this.closed = true }
}

module.exports = { AccountSecurityRepository }
