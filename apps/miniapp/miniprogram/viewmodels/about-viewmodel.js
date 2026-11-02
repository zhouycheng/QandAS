const practiceRepository = require('../repositories/practice-repository.js')
const content = require('../data/about.js')

class AboutViewModel {
  constructor(options) {
    const input = options || {}
    this.repository = input.repository || practiceRepository
    this.storage = input.storage
    this.version = input.version || ''
  }

  static getInitialData() {
    return { version: '', developers: content.developers, donationCodes: content.donationCodes, paragraphs: content.paragraphs, playgroundEnabled: false }
  }

  load() {
    return { data: Object.assign(AboutViewModel.getInitialData(), {
      version: this.version,
      playgroundEnabled: !!this.repository.isPlaygroundEnabled()
    }) }
  }

  unlockPlayground() {
    try {
      this.repository.setPlaygroundEnabled(this.storage, true)
      return this.load()
    } catch (error) {
      return { command: { type: 'toast', title: '设置保存失败，请重试' } }
    }
  }

  openPlayground() {
    if (!this.repository.isPlaygroundEnabled()) return null
    return { command: { type: 'navigate', url: '/page/playground/index' } }
  }

  copyDeveloper(username) {
    const member = content.developers.find(item => item.username === username)
    return member ? { command: { type: 'copy', text: member.url } } : null
  }
}

module.exports = { AboutViewModel }
