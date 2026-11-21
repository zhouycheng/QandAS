const { CommunityGroupViewModel } = require('../../viewmodels/community-group-viewmodel.js')

Component({
  properties: { inline: { type: Boolean, value: false }, compact: { type: Boolean, value: false }, hideUnavailable: { type: Boolean, value: false } },
  data: CommunityGroupViewModel.getInitialData(),
  lifetimes: {
    attached() { this.active = true; this.viewModel = new CommunityGroupViewModel(); this.refresh(false) },
    detached() { this.active = false; clearTimeout(this.expiryTimer) }
  },
  pageLifetimes: {
    show() { this.pageShown = true; this.refresh(false) },
    hide() { this.pageShown = false; this.refreshPromise = null; this.refreshVersion = (this.refreshVersion || 0) + 1; clearTimeout(this.expiryTimer); this.setData({ loading: false, imageUrl: '' }) }
  },
  methods: {
    refresh(preview) {
      if (this.refreshPromise) {
        if (preview === true) this.previewRequested = true
        return this.refreshPromise
      }
      this.previewRequested = preview === true
      const pending = this.loadGroup().finally(() => { if (this.refreshPromise === pending) this.refreshPromise = null })
      this.refreshPromise = pending
      return pending
    },
    async loadGroup() {
      const version = this.refreshVersion = (this.refreshVersion || 0) + 1
      this.setData({ loading: true, message: '' })
      const result = await this.viewModel.load()
      if (!this.active || this.pageShown === false || this.refreshVersion !== version) return
      this.setData(result.data)
      clearTimeout(this.expiryTimer)
      if (result.data.imageUrl) {
        this.expiryTimer = setTimeout(() => { this.setData({ imageUrl: '' }); this.refresh(false) }, Math.min(2147483647, Math.max(0, Date.parse(result.data.expiresAt) - Date.now())))
      }
      if (this.previewRequested && result.data.imageUrl) {
        wx.previewImage({ current: result.data.imageUrl, urls: [result.data.imageUrl], fail: () => {
          if (this.active && this.refreshVersion === version) this.imageError()
        } })
      }
    },
    open() { return this.refresh(true) },
    imageError() { this.setData({ imageUrl: '', message: '群二维码加载失败，点击重试', retryable: true }) }
  }
})
