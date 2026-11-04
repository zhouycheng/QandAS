const { CommunityGroupViewModel } = require('../../viewmodels/community-group-viewmodel.js')

Component({
  properties: { inline: { type: Boolean, value: false }, compact: { type: Boolean, value: false }, hideUnavailable: { type: Boolean, value: false } },
  data: CommunityGroupViewModel.getInitialData(),
  lifetimes: {
    attached() { this.active = true; this.viewModel = new CommunityGroupViewModel(); this.refresh(false) },
    detached() { this.active = false; clearTimeout(this.expiryTimer) }
  },
  methods: {
    async refresh(preview) {
      if (this.data.loading) return
      this.setData({ loading: true, message: '' })
      const result = await this.viewModel.load(preview === true)
      if (this.data.hideUnavailable && result.data.imageUrl) {
        const loaded = await new Promise(resolve => wx.getImageInfo({ src: result.data.imageUrl, success: () => resolve(true), fail: () => resolve(false) }))
        if (!loaded || Date.parse(result.data.expiresAt) <= Date.now()) {
          result.data.imageUrl = ''
          result.command = null
        }
      }
      if (!this.active) return
      this.setData(result.data)
      clearTimeout(this.expiryTimer)
      if (result.data.imageUrl) {
        this.expiryTimer = setTimeout(() => { this.setData({ imageUrl: '' }); this.refresh(false) }, Math.min(2147483647, Math.max(0, Date.parse(result.data.expiresAt) - Date.now())))
      }
      if (result.command) wx.previewImage({ current: result.command.url, urls: [result.command.url], fail: () => this.imageError() })
    },
    open() { return this.refresh(true) },
    imageError() { this.setData({ imageUrl: '', message: '群二维码加载失败，点击重试', retryable: true }) }
  }
})
