const remote = require('../repositories/remote-data-repository.js')
const repository = require('../repositories/practice-repository.js')
const { describeAuth, getProviderLabel } = require('../utils/auth-session.js')
const { maskEmail } = require('../utils/auth-form.js')
const { AccountSecurityRepository } = require('../repositories/account-security-repository.js')
const { uuid } = require('../repositories/api-transport.js')

class AccountViewModel {
  constructor(options) {
    this.storage = options.storage
    this.repository = options.repository || repository
    this.securityRepository = options.securityRepository
    this.editRevision = 0
  }
  static getInitialData() {
    return { loggedIn: false, profile: {}, draft: { nickname: '', avatarUrl: '' }, dirty: false, saving: false, avatarPreparing: false, nicknameFocus: false, wechatBinding: false }
  }
  readAuth() {
    const raw = this.repository.getAuth(this.storage)
    return { view: describeAuth(raw), token: raw.token, profile: raw.profile, nickname: raw.nickname || '' }
  }
  readProfile() {
    const identity = this.readAuth()
    const profile = remote.getProfile(this.storage) || identity.profile || {}
    return {
      nickname: profile.nickname || identity.nickname, avatarUrl: profile.avatarUrl || identity.view.avatarUrl || '',
      emailMasked: maskEmail(profile.email || ''), providerLabel: getProviderLabel(identity.view.provider),
      isTestAccount: !!profile.isTestAccount, wechatBound: !!profile.wechatBound,
      wechatStatus: profile.wechatBound ? '已绑定' : '未绑定', wechatAction: profile.wechatBound ? '' : '绑定'
    }
  }
  load() {
    const profile = this.readProfile()
    this.pending = { nickname: profile.nickname, avatarUrl: profile.avatarUrl }
    this.loadedEditRevision = this.editRevision
    return { data: { loggedIn: this.readAuth().view.loggedIn, profile, draft: Object.assign({}, this.pending), dirty: false, saving: false } }
  }
  async refreshRemote(options) {
    const revision = this.editRevision
    try {
      await this.repository.refreshRemote(this.storage, 'profile', options)
      return revision !== this.editRevision || this.dirtyNow() ? { data: { profile: this.readProfile() } } : this.load()
    } catch (error) { return { command: { type: 'toast', title: error.message } } }
  }
  projectRemote() { return { profile: this.readProfile() } }
  setField(key, value) {
    if (!['nickname', 'avatarUrl'].includes(key)) return null
    this.editRevision += 1
    this.pending = Object.assign({}, this.pending || this.readProfile(), { [key]: typeof value === 'string' ? value : '' })
    return { data: { dirty: this.dirtyNow() } }
  }
  dirtyNow() {
    if (!this.pending) return false
    const profile = this.readProfile()
    return this.pending.nickname !== profile.nickname || this.pending.avatarUrl !== profile.avatarUrl
  }
  async save() {
    if (!this.readAuth().view.loggedIn) return { command: { type: 'navigate', url: '/page/login/index' } }
    if (this.saving || !this.dirtyNow()) return null
    const nickname = (this.pending.nickname || '').trim()
    if (!nickname) return { command: { type: 'toast', title: '请填写昵称' } }
    const patch = { nickname }
    if (this.pending.avatarUrl !== this.readProfile().avatarUrl) patch.avatar = this.pending.avatarUrl
    this.saving = true
    try {
      await remote.saveProfile(this.storage, patch)
      return Object.assign(this.load(), { command: { type: 'toast', title: '资料已保存' } })
    } finally { this.saving = false }
  }
  tapEmail() {
    if (this.readProfile().isTestAccount) return { command: { type: 'toast', title: '测试账号的登录凭据由管理员管理' } }
    return { command: { type: 'navigate', url: this.readAuth().view.loggedIn ? '/page/account-security/index?mode=email' : '/page/login/index' } }
  }
  tapWechat() {
    if (this.readProfile().isTestAccount) return { command: { type: 'toast', title: '测试账号使用固定登录凭据' } }
    if (!this.readAuth().view.loggedIn) return { command: { type: 'navigate', url: '/page/login/index' } }
    if (!this.readProfile().wechatBound && !this.wechatBinding) return { command: { type: 'confirm-wechat-binding' } }
    return null
  }
  async bindWechat() {
    if (this.wechatBinding || this.readProfile().isTestAccount) return null
    this.wechatBinding = true
    try {
      const security = this.securityRepository || (this.securityRepository = new AccountSecurityRepository(this.storage))
      const profile = await security.load()
      if (!profile.wechatBound) {
        if (!this.wechatInput) { this.wechatInput = { expectedVersion: profile.version, code: await security.wechatCode() }; this.wechatKey = uuid() }
        await security.wechat(this.wechatInput, this.wechatKey)
        await security.refresh()
      }
      this.wechatInput = null
      return { data: { profile: this.readProfile() }, command: { type: 'toast', title: '微信已绑定' } }
    } catch (error) {
      if (error.statusCode) this.wechatInput = null
      throw error
    } finally { this.wechatBinding = false }
  }
}
module.exports = { AccountViewModel }
