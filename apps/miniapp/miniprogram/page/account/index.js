const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { AccountViewModel } = require('../../viewmodels/account-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
Page(withPageLifecycle({
  data: AccountViewModel.getInitialData(),

  onLoad(options) {
    this.viewModel = new AccountViewModel({
      storage: createWxStorageAdapter(), required: options && options.required === '1'
    })

  },

  /** 从登录 / 找回密码返回时资料可能变了；正在编辑就不覆盖用户输入 */
  onShow() {
    if (this.viewModel && !this.data.dirty) {
      this.applyViewModelResult(this.viewModel.load())
      this.applyViewModelResult(this.viewModel.refreshRemote())
    }
  },

  /**
   * 输入只更新「有改动」标记，不回写 value。
   * 回写 value 会让真机上的光标每敲一个字跳到末尾，中文输入法还会打断联想。
   */
  handleFieldInput(e) {
    const key = e.currentTarget.dataset.key

    this.applyViewModelResult(this.viewModel.setField(key, e.detail.value))
  },

  handleFieldBlur(e) {
    const key = e.currentTarget.dataset.key

    this.applyViewModelResult(this.viewModel.setField(key, e.detail.value))
  },

  /**
   * 头像：chooseAvatar 给的是临时文件，下次冷启动就失效，
   * 所以立刻转存到 USER_DATA_PATH 再用。转存失败就用临时路径先顶上，
   * 至少这次会话里看得到。
   */
  handleChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl

    if (!tempPath) {
      return
    }

    if (!wx.getFileSystemManager || !wx.env || !wx.env.USER_DATA_PATH) {
      this.applyViewModelResult(this.viewModel.setField('avatarUrl', tempPath))
      return
    }

    const target = `${wx.env.USER_DATA_PATH}/avatar-${Date.now()}.jpg`

    try {
      wx.getFileSystemManager().copyFileSync(tempPath, target)
      this.applyViewModelResult(this.viewModel.setField('avatarUrl', target))
    } catch (error) {
      this.applyViewModelResult(this.viewModel.setField('avatarUrl', tempPath))
    }
  },

  handleCollegeChange(e) {
    this.applyViewModelResult(this.viewModel.selectCollege(e.detail.value))
  },

  handleCollegeOpen() {
    this.setData({ collegePickerVisible: true, collegeLoading: true, collegeError: '' })
    return this.viewModel.loadColleges(1).then(result => this.applyViewModelResult(result))
      .catch(error => this.setData({ collegeError: error.message }))
      .finally(() => this.setData({ collegeLoading: false }))
  },

  handleCollegeMore() {
    if (this.data.collegeLoading) return
    this.setData({ collegeLoading: true })
    return this.viewModel.loadColleges((this.data.collegePage || 1) + 1).then(result => this.applyViewModelResult(result))
      .catch(error => this.setData({ collegeError: error.message }))
      .finally(() => this.setData({ collegeLoading: false }))
  },

  handleCollegeClose() { this.setData({ collegePickerVisible: false }) },
  handleCollegePick(e) {
    this.applyViewModelResult(this.viewModel.selectCollege(e.currentTarget.dataset.index))
    this.handleCollegeClose()
  },

  handleGradeChange(e) { this.applyViewModelResult(this.viewModel.selectGrade(e.detail.value)) },
  handleMajorOpen() { return this.loadMajorPage(1) },
  handleMajorMore() { if (!this.data.majorLoading) return this.loadMajorPage(this.data.majorPage + 1) },
  loadMajorPage(page) {
    this.setData({ majorPickerVisible: true, majorLoading: true, majorError: '' })
    return this.viewModel.loadMajors(page).then(result => this.applyViewModelResult(result))
      .catch(error => this.setData({ majorError: error.message }))
      .finally(() => this.setData({ majorLoading: false }))
  },
  handleMajorClose() { this.setData({ majorPickerVisible: false }) },
  handleMajorPick(e) {
    this.applyViewModelResult(this.viewModel.selectMajor(e.currentTarget.dataset.index))
    this.handleMajorClose()
  },

  handleEmailTap() {
    this.applyViewModelResult(this.viewModel.tapEmail())
  },

  handleWechatTap() {
    this.applyViewModelResult(this.viewModel.tapWechat())
  },

  handlePasswordTap() {
    this.applyViewModelResult(this.viewModel.tapPassword())
  },

  handleSaveTap() {
    this.applyViewModelResult(this.viewModel.save())
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

    if (result.command.type === 'profile-complete') {
      const pages = getCurrentPages()
      let index = pages.length - 2
      while (index >= 0 && /page\/(login|register|account)\/index/.test(pages[index].route)) index -= 1
      if (index >= 0) wx.navigateBack({ delta: pages.length - 1 - index })
      else navigation.reLaunch({ url: '/page/subject-list/index' })
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
