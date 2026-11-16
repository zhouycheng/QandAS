const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { AccountViewModel } = require('../../viewmodels/account-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
Page(withPageLifecycle({
  data: AccountViewModel.getInitialData(),

  onLoad() {
    this.viewModel = new AccountViewModel({
      storage: createWxStorageAdapter()
    })
  },

  /** 从邮箱验证或注销页面返回时刷新绑定状态。 */
  onShow() {
    if (!this.viewModel) {
      return
    }

    this.applyViewModelResult(this.viewModel.load())
    this.applyViewModelResult(this.viewModel.refreshRemote())
  },

  onUnload() {
    if (this.viewModel && this.viewModel.securityRepository) {
      this.viewModel.securityRepository.close()
    }
  },

  handleEmailTap() {
    this.applyViewModelResult(this.viewModel.tapEmail())
  },

  handleWechatTap() {
    this.applyViewModelResult(this.viewModel.tapWechat())
  },

  handleAccountDeletion() {
    navigation.navigateTo({ url: '/page/account-deletion/index' })
  },

  applyViewModelResult(result) {
    if (result && typeof result.then === 'function') {
      return result.then((value) => this.applyViewModelResult(value)).catch((error) => wx.showToast({ title: error.message || '请求失败', icon: 'none' }))
    }
    if (!result) {
      return
    }

    if (result.data) {
      this.setData(result.data)
    }

    if (!result.command) {
      return
    }

    if (result.command.type === 'confirm-wechat-binding') {
      wx.showModal({
        title: '绑定微信',
        content: '将当前微信绑定到此账号，之后可使用微信登录。',
        confirmText: '确认绑定',
        success: (choice) => {
          if (!choice.confirm || this._pageUnloaded) return
          this.setData({ wechatBinding: true })
          this.applyViewModelResult(this.viewModel.bindWechat()).finally(() => {
            if (!this._pageUnloaded) this.setData({ wechatBinding: false })
          })
        }
      })
      return
    }

    if (result.command.type === 'toast') {
      wx.showToast({
        title: result.command.title || '操作完成',
        icon: 'none',
        duration: 1800
      })
      return
    }

    if (result.command.type === 'navigate' && result.command.url) {
      navigation.navigateTo({
        url: result.command.url
      })
    }
  }
}))
