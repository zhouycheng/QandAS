const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { AboutViewModel } = require('../../viewmodels/about-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')

Page(withPageLifecycle({
  data: AboutViewModel.getInitialData(),
  onLoad() {
    const app = getApp()
    let version = app && app.globalData ? app.globalData.version : ''
    try {
      const info = wx.getAccountInfoSync()
      version = info.miniProgram.version || version
    } catch (error) {}
    this.viewModel = new AboutViewModel({
      storage: createWxStorageAdapter(),
      version
    })
  },
  onShow() { this.applyViewModelResult(this.viewModel.load()) },
  handleDeveloperTap(event) { this.applyViewModelResult(this.viewModel.copyDeveloper(event.currentTarget.dataset.username)) },
  handleDonationTap(event) {
    const code = this.data.donationCodes[event.currentTarget.dataset.index]
    if (code) wx.previewImage({ current: code.image, urls: this.data.donationCodes.map(item => item.image) })
  },
  applyViewModelResult(result) {
    if (!result) return
    if (result.data) this.setData(result.data)
    if (!result.command) return
    if (result.command.type === 'navigate') navigation.navigateTo({ url: result.command.url })
    if (result.command.type === 'toast') wx.showToast({ title: result.command.title, icon: 'none' })
    if (result.command.type === 'copy') wx.setClipboardData({
      data: result.command.text,
      success: () => wx.showToast({ title: 'GitHub 地址已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' })
    })
  }
}))
