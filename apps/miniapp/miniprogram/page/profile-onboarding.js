const auth = require('../repositories/auth-repository.js')
const remote = require('../repositories/remote-data-repository.js')
const repository = require('../repositories/profile-onboarding-repository.js')
const { createWxStorageAdapter } = require('../utils/wx-storage.js')
const { decide } = require('../utils/profile-onboarding.js')
const { needsProfile } = require('../utils/profile-rules.js')
const navigation = require('../utils/navigation.js')
const HOME = '/page/subject-list/index'
const SAFE_PAGES = new Set(['page/subject-list/index', 'page/bank-detail/index', 'page/stats/index', 'page/my/index'])
let checking = false
let destination = null
const current = repository.current
function start() { destination = null; repository.start() }
function visible(page) {
  const pages = getCurrentPages()
  return !page._pageUnloaded && pages[pages.length - 1] === page
}
async function showPending(page) {
  const pending = repository.getPending()
  if (!pending || checking || !SAFE_PAGES.has(page.route) || !visible(page)) return
  const event = pending
  if (!current(event.identity)) { repository.clearPending(event); return }
  checking = true
  try {
    if (event.force) {
      await remote.refreshProfile(createWxStorageAdapter(), { force: true })
      event.force = false
    }
    if (repository.getPending() !== event || !current(event.identity) || !visible(page)) return
    const storage = createWxStorageAdapter(), identity = auth.getAuth(storage)
    repository.clearPending(event)
    const decision = decide(identity, repository.localSeen(storage, identity.userId).seen, event.codeLogin)
    if (decision.type === 'NONE') return
    repository.syncSeen(identity)
    if (decision.type === 'SETUP') {
      destination = { url: '/' + page.route, userId: identity.userId }
      if (page.route === 'page/bank-detail/index' && page.data.subjectId) getApp().setPendingSubjectId(page.data.subjectId)
      navigation.reLaunch({ url: '/page/profile-setup/index' })
    } else {
      if (event.codeLogin && needsProfile(identity)) repository.markSeen()
      wx.showModal({ title: '完善账号资料', content: decision.content, confirmText: '去填写', cancelText: '稍后再说', success: result => {
        if (result.confirm && current(identity) && visible(page)) navigation.navigateTo({ url: '/page/account/index' })
      } })
    }
  } catch (_) {
    repository.clearPending(event)
  } finally {
    checking = false
    const top = getCurrentPages().slice(-1)[0]
    if (repository.getPending() && top) showPending(top)
  }
}
function finishAuthentication() {
  destination = null
  const pages = getCurrentPages()
  let index = pages.length - 2
  while (index >= 0 && /^page\/(login|register|forgot-password|account-security)\//.test(pages[index].route)) index -= 1
  if (index < 0) navigation.reLaunch({ url: HOME })
  else wx.navigateBack({ delta: pages.length - 1 - index, fail: () => navigation.reLaunch({ url: HOME }) })
}
function finish() {
  const identity = auth.getAuth(createWxStorageAdapter())
  const url = destination && destination.userId === identity.userId ? destination.url : HOME
  navigation.reLaunch({ url, success: () => { destination = null }, fail: () => wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }) })
}
module.exports = { start, showPending, finish, finishAuthentication }
