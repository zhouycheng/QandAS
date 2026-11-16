const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { AccountSecurityViewModel } = require('../../viewmodels/account-security-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const cooldown = require('../../utils/cooldown.js')

// 浮窗切回时页面可能被回收重建：把服务端签发的验证句柄留在本机，
// 用户不必在验证码有效期内重新收信。只存句柄，不存验证码本身。
const CHALLENGE_KEY = 'qandaEmailChallenge:v1:account-security'

Page(withPageLifecycle({
  data: Object.assign(AccountSecurityViewModel.getInitialData(), cooldown.getInitialCooldownData()),
  onLoad(options) {
    this.cooldownStore = createWxStorageAdapter()
    this.viewModel = new AccountSecurityViewModel({ storage: this.cooldownStore, mode: options.mode })
    const saved = this.loadChallenge()
    if (saved) {
      const endAt = Number(saved.endAt) || 0
      if (endAt > Date.now()) {
        this.cooldownEndAt = endAt
        this.viewModel.cooldownEndAt = endAt
      }
      if (saved.challenge && saved.challenge.id && Date.parse(saved.challenge.expiresAt) > Date.now()) this.viewModel.challenge = saved.challenge
    }
    this.handleRetry()
  },
  onShow() {
    if (!this.cooldownStore) this.cooldownStore = createWxStorageAdapter()
    cooldown.resume(this, { storage: this.cooldownStore, purpose: 'account-security' })
  },
  onHide() { cooldown.stop(this) },
  onUnload() { cooldown.stop(this); this.viewModel.dispose() },
  loadChallenge() {
    try { return this.cooldownStore.get(CHALLENGE_KEY) || null } catch (_) { return null }
  },
  saveChallenge() {
    try {
      const challenge = this.viewModel.challenge
      if (!challenge || !challenge.id) { this.cooldownStore.remove(CHALLENGE_KEY); return }
      this.cooldownStore.set(CHALLENGE_KEY, { challenge, endAt: this.viewModel.cooldownEndAt || this.cooldownEndAt || 0 })
    } catch (_) { /* 记忆失败只影响续用，不影响本次发送 */ }
  },
  clearChallenge() {
    try { this.cooldownStore.remove(CHALLENGE_KEY) } catch (_) { /* 清理失败不阻断流程 */ }
  },
  handleRetry() { return this.viewModel.load().then(result => this.applyViewModelResult(result)) },
  handleInput(event) { this.applyViewModelResult(this.viewModel.setField(event.currentTarget.dataset.key, event.detail.value)) },
  handleSendCode() {
    if (this.data.cooldown || this.data.sending || this.data.submitting) return
    this.setData({ sending: true })
    return this.viewModel.sendCode().then(result => { this.applyViewModelResult(result); if (!this._pageUnloaded) this.setData({ sending: false }) })
  },
  handleSubmit() {
    if (this.data.submitting || this.data.sending) return
    this.setData({ submitting: true })
    return this.viewModel.submit().then(result => { this.applyViewModelResult(result); if (!this._pageUnloaded) this.setData({ submitting: false }) })
  },
  applyViewModelResult(result) {
    if (!result) return
    if (result.data) this.setData(result.data)
    const command = result.command
    if (!command) return
    if (command.type === 'cooldown') {
      const challenge = this.viewModel.challenge || {}
      cooldown.begin(this, command.seconds, { storage: this.cooldownStore, purpose: 'account-security', email: challenge.email || this.viewModel.fields.email })
      this.saveChallenge()
    }
    if (command.type === 'reset-cooldown') { cooldown.stop(this); this.cooldownEndAt = 0; this.viewModel.cooldownEndAt = 0; this.setData({ cooldown: 0 }); this.clearChallenge() }
    if (command.type === 'login') navigation.redirectTo({ url: '/page/login/index?email=' + encodeURIComponent(command.email || '') + '&reason=' + encodeURIComponent(command.reason || '') })
    if (command.type === 'back') wx.navigateBack()
    if (command.title) wx.showToast({ title: command.title, icon: 'none' })
  }
}))
