const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { AccountViewModel } = require('../../viewmodels/account-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
Page(withPageLifecycle({
  data: AccountViewModel.getInitialData(),

  onLoad(options) {
    this.viewModel = new AccountViewModel({
      storage: createWxStorageAdapter()
    })

  },

  /** 从账号安全页面返回时刷新绑定状态，保留未保存的资料。 */
  onShow() {
    if (this.viewModel && !this.data.dirty) {
      this.applyViewModelResult(this.viewModel.load())
      this.applyViewModelResult(this.viewModel.refreshRemote())
    } else if (this.viewModel) {
      this.applyViewModelResult(this.viewModel.refreshRemote())
    }
  },
  onUnload() { if (this.viewModel.securityRepository) this.viewModel.securityRepository.close() },

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

  handleChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl
    if (!tempPath || this.data.avatarPreparing || this.data.saving) return
    const token = this.viewModel.readAuth().token
    const selection = this._avatarSelection = (this._avatarSelection || 0) + 1
    const current = () => !this._pageUnloaded && selection === this._avatarSelection && token === this.viewModel.readAuth().token
    const fail = title => { if (current()) { this.setData({ avatarPreparing: false }); wx.showToast({ title, icon: 'none' }) } }
    this.setData({ avatarPreparing: true })
    wx.compressImage({ src: tempPath, quality: 80, compressedWidth: 160, compressedHeight: 160,
      success: image => wx.getFileSystemManager().readFile({ filePath: image.tempFilePath, encoding: 'base64',
        success: file => {
          if (!current()) return
          const data = file.data
          const type = typeof data === 'string' && (data.startsWith('/9j/') ? 'jpeg' : data.startsWith('iVBORw0KGgo') ? 'png' : '')
          if (!type || data.length > 87384) { fail('头像过大或格式不支持，请重新选择'); return }
          const avatar = `data:image/${type};base64,${data}`
          this.applyViewModelResult(this.viewModel.setField('avatarUrl', avatar))
          this.setData({ 'draft.avatarUrl': avatar, avatarPreparing: false })
        }, fail: () => fail('头像读取失败，请重新选择')
      }), fail: () => fail('头像处理失败，请重新选择')
    })
  },

  handleUseWechatNickname() {
    this.setData({ nicknameFocus: false }, () => this.setData({ nicknameFocus: true }))
  },
  handleNicknameReview(e) {
    if (e.detail.pass === false) {
      this.applyViewModelResult(this.viewModel.setField('nickname', ''))
      this.setData({ 'draft.nickname': '' })
      wx.showToast({ title: '此昵称暂不可用，请重新选择', icon: 'none' })
    }
  },

  ...require('../../utils/profile-selectors.js'),

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
    if (this.data.avatarPreparing) return
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

    if (result.command.type === 'confirm-wechat-binding') {
      wx.showModal({ title: '绑定微信', content: '将当前微信绑定到此账号，之后可使用微信登录。', confirmText: '确认绑定', success: choice => {
        if (!choice.confirm || this._pageUnloaded) return
        this.setData({ wechatBinding: true })
        this.applyViewModelResult(this.viewModel.bindWechat()).finally(() => { if (!this._pageUnloaded) this.setData({ wechatBinding: false }) })
      } })
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
