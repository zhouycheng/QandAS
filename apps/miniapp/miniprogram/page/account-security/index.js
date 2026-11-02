const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { AccountSecurityViewModel } = require('../../viewmodels/account-security-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const cooldown = require('../../utils/cooldown.js')

Page(withPageLifecycle({
  data: Object.assign(AccountSecurityViewModel.getInitialData(), cooldown.getInitialCooldownData()),
  onLoad(options) {
    this.viewModel = new AccountSecurityViewModel({ storage: createWxStorageAdapter(), mode: options.mode })
    this.handleRetry()
  },
  onShow() { cooldown.resume(this) },
  onHide() { cooldown.stop(this) },
  onUnload() { cooldown.stop(this); this.viewModel.dispose() },
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
  handleBindEmail() { navigation.redirectTo({ url: '/page/account-security/index?mode=email' }) },
  applyViewModelResult(result) {
    if (!result) return
    if (result.data) this.setData(result.data)
    const command = result.command
    if (!command) return
    if (command.type === 'cooldown') cooldown.begin(this, command.seconds)
    if (command.type === 'reset-cooldown') { cooldown.stop(this); this.cooldownEndAt = 0; this.setData({ cooldown: 0 }) }
    if (command.type === 'login') navigation.redirectTo({ url: '/page/login/index?email=' + encodeURIComponent(command.email || '') + '&reason=' + encodeURIComponent(command.reason || '') })
    if (command.type === 'back') wx.navigateBack()
    if (command.title) wx.showToast({ title: command.title, icon: 'none' })
  }
}))
