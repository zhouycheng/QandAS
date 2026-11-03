const { AccountViewModel } = require('../../viewmodels/account-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const onboarding = require('../profile-onboarding.js')
const navigation = require('../../utils/navigation.js')
Page(withPageLifecycle({
  data: Object.assign(AccountViewModel.getInitialData(), { loading: true, loadError: '', canContinue: false }),
  onLoad() {
    this.viewModel = new AccountViewModel({ storage: createWxStorageAdapter(), required: true })
    this.token = this.viewModel.readAuth().token
    if (!this.token) { navigation.reLaunch({ url: '/page/login/index' }); return }
    this.applyViewModelResult(this.viewModel.load())
    this.handleReload()
  },
  onShow() { if (this.token && !this.isCurrent()) this.leaveChangedAccount() },
  leaveChangedAccount() { if (!this._pageUnloaded && getCurrentPages().slice(-1)[0] === this) navigation.reLaunch({ url: this.viewModel.readAuth().token ? '/page/subject-list/index' : '/page/login/index' }) },
  onReady() { if (this.isCurrent()) require('../../repositories/profile-onboarding-repository.js').markSeen() },
  isCurrent() { return !this._pageUnloaded && this.token && this.token === this.viewModel.readAuth().token },
  async handleReload(reason) {
    if (!this.isCurrent()) return
    this.setData({ loading: true, loadError: '' })
    try {
      const result = await this.viewModel.refreshRemote({ force: true })
      if (!this.isCurrent()) { if (!this.viewModel.readAuth().token) this.leaveChangedAccount(); return }
      this.applyViewModelResult(result)
      if (result && result.command && result.command.type === 'toast') this.setData({ loadError: result.command.title })
      else if (reason !== true && this.viewModel.readAuth().profile.profileComplete) onboarding.finish()
    } finally { if (this.isCurrent()) { this.setData({ loading: false }); this.updateCanContinue() } }
  },
  ...require('../profile-selectors.js'),
  updateCanContinue() {
    const draft = this.viewModel.pending || {}
    this.setData({ canContinue: !!(draft.collegeId && draft.majorId && draft.currentGrade >= 1 && draft.currentGrade <= 5 && !this.data.loading && !this.data.loadError && !this.data.saving && !this.busy) })
  },
  applyViewModelResult(result) {
    if (!this.isCurrent() || !result) return
    if (result.data) this.setData(Object.assign({}, result.data, this.busy ? { saving: true } : {}))
    this.updateCanContinue()
  },
  async handleSaveTap() {
    if (!this.isCurrent() || !this.data.canContinue || this.busy) return
    this.busy = true
    this.setData({ saving: true, canContinue: false })
    try {
      const result = await this.viewModel.save()
      if (!this.isCurrent()) { if (!this.viewModel.readAuth().token) this.leaveChangedAccount(); return }
      if (result && result.command && result.command.type === 'profile-complete') onboarding.finish()
      else if (result && result.command) wx.showToast({ title: result.command.title, icon: 'none' })
    } catch (error) {
      if (!this.isCurrent()) { if (!this.viewModel.readAuth().token) this.leaveChangedAccount(); return }
      if (error.statusCode === 409) await this.handleReload(true)
      if (this.isCurrent()) wx.showToast({ title: error.message || '保存失败，请重试', icon: 'none' })
    } finally {
      this.busy = false
      if (this.isCurrent()) { this.setData({ saving: false }); this.updateCanContinue() }
    }
  },
  handleSkip() { if (!this.isCurrent()) this.leaveChangedAccount(); else if (!this.busy) onboarding.finish() }
}))
