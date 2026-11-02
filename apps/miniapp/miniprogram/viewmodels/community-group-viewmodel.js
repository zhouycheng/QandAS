const repository = require('../repositories/community-group-repository.js')

class CommunityGroupViewModel {
  constructor(options) { this.repository = options && options.repository || repository }
  static getInitialData() { return { loading: false, imageUrl: '', expiresAt: '', message: '', retryable: false } }
  async load(preview) {
    try {
      const group = await this.repository.load()
      const available = group.available && Date.parse(group.expiresAt) > Date.now()
      const data = { loading: false, imageUrl: available ? group.imageUrl : '', expiresAt: available ? group.expiresAt : '', message: available ? '' : group.expiresAt ? '群二维码已过期，等待更新' : '群二维码更新中，请稍后再试', retryable: !available }
      return { data, command: available && preview ? { type: 'preview', url: group.imageUrl } : null }
    } catch (error) {
      return { data: { loading: false, imageUrl: '', expiresAt: '', message: error.message || '群二维码读取失败，请重试', retryable: true } }
    }
  }
}

module.exports = { CommunityGroupViewModel }
