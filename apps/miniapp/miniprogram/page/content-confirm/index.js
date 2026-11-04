const repository = require('../../repositories/content-confirmation-repository.js')
Page({
  data: { confirmationCode: '', loading: false, invitation: null, error: '', completed: false },
  onLoad() { if (wx.hideShareMenu) wx.hideShareMenu() },
  onUnload() { this.closed = true; this.code = ''; this.inspectedCode = '' },
  handleInput(event) { this.code = event.detail.value; this.inspectedCode = ''; this.setData({ invitation: null, error: '', completed: false }) },
  async handleInspect() {
    if (this.data.loading) return
    const code = this.code
    this.setData({ loading: true, error: '' })
    try {
      const invitation = await repository.inspect(code)
      if (!this.closed && code === this.code) { this.inspectedCode = code; this.setData({ invitation }) }
    } catch (error) { if (!this.closed) this.setData({ error: error.message }) }
    finally { if (!this.closed) this.setData({ loading: false }) }
  },
  async handleConfirm() {
    if (this.data.loading || !this.inspectedCode || this.inspectedCode !== this.code) return
    const confirmation = this.inspectedCode
    this.setData({ loading: true, error: '' })
    try {
      const code = await new Promise((resolve, reject) => wx.login({ timeout: 10000, success: result => result.code ? resolve(result.code) : reject(new Error('请重新获取微信凭证')), fail: () => reject(new Error('微信凭证获取失败，请重试')) }))
      if (this.closed || confirmation !== this.code) return
      await repository.confirm(confirmation, code)
      if (!this.closed) { this.code = ''; this.inspectedCode = ''; this.setData({ completed: true, confirmationCode: '', invitation: null }) }
    } catch (error) { if (!this.closed) this.setData({ error: error.message }) }
    finally { if (!this.closed) this.setData({ loading: false }) }
  }
})
