const { AccountDeletionRepository } = require('../../repositories/account-deletion-repository.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const { maskEmail } = require('../../utils/auth-form.js')
const navigation = require('../../utils/navigation.js')
Page({
  data: { loading: true, method: '', emailMasked: '', accountLabel: '', verified: false, acknowledged: false, confirming: false, error: '', cooldown: 0 },
  async onLoad() {
    this.repository = new AccountDeletionRepository(createWxStorageAdapter())
    try {
      const profile = await this.repository.load()
      const accountLabel = profile.method === 'EMAIL' ? maskEmail(profile.email) : profile.method === 'WECHAT' ? '当前微信登录身份' : '当前测试账号'
      if (!this.closed) this.setData({ method: profile.method, emailMasked: maskEmail(profile.email), accountLabel, loading: false })
    } catch (error) { if (!this.closed) this.setData({ error: error.message, loading: false }) }
  },
  onUnload() { this.closed = true; this.value = ''; if (this.timer) clearInterval(this.timer); if (this.repository) this.repository.proof = '' },
  handleInput(event) { this.value = event.detail.value },
  async handleSendCode() {
    if (this.data.loading || this.data.cooldown) return
    this.setData({ loading: true, error: '' })
    try {
      const challenge = await this.repository.issue()
      if (this.closed) return
      this.setData({ cooldown: challenge.resendAfterSeconds || 60 })
      this.timer = setInterval(() => { if (!this.closed) this.setData({ cooldown: Math.max(0, this.data.cooldown - 1) }); if (this.data.cooldown <= 0) clearInterval(this.timer) }, 1000)
    } catch (error) { if (!this.closed) this.setData({ error: error.message }) }
    finally { if (!this.closed) this.setData({ loading: false }) }
  },
  async handleVerify() {
    if (this.data.loading || !this.data.method) return
    this.setData({ loading: true, error: '' })
    try {
      const code = this.data.method === 'WECHAT' ? await new Promise((resolve, reject) => wx.login({ timeout: 10000, success: result => result.code ? resolve(result.code) : reject(new Error('请重新获取微信凭证')), fail: () => reject(new Error('微信验证失败，请重试')) })) : ''
      if (this.closed) return
      await this.repository.verify(this.value || '', code)
      this.value = ''
      if (!this.closed) this.setData({ verified: true, acknowledged: false })
    } catch (error) { if (!this.closed) this.setData({ error: error.message }) }
    finally { if (!this.closed) this.setData({ loading: false }) }
  },
  handleAckToggle() {
    if (this.data.loading) return
    this.setData({ acknowledged: !this.data.acknowledged })
  },
  handleDelete() {
    if (!this.data.verified || this.data.loading || !this.data.acknowledged) return
    this.setData({ confirming: true, error: '' })
  },
  handleConfirmClose() {
    if (this.data.loading || this.closed) return
    this.setData({ confirming: false })
  },
  async handleConfirmDelete() {
    if (!this.data.verified || this.data.loading || !this.data.acknowledged) return
    this.setData({ loading: true, error: '' })
    try {
      await this.repository.erase()
      if (!this.closed) navigation.switchTab({ url: '/page/subject-list/index' })
    } catch (error) {
      if (!this.closed) this.setData({ error: error.message, confirming: false })
    } finally {
      if (!this.closed) this.setData({ loading: false })
    }
  }
})
