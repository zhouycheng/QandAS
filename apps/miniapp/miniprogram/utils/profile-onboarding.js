const auth = require('../repositories/auth-repository.js')
const remote = require('../repositories/remote-data-repository.js')
const api = require('../repositories/api-transport.js')
const { createWxStorageAdapter } = require('./wx-storage.js')
const { needsProfile } = require('./profile-rules.js')
const navigation = require('./navigation.js')
const HOME = '/page/subject-list/index'
const SAFE_PAGES = new Set(['page/subject-list/index', 'page/bank-detail/index', 'page/stats/index', 'page/my/index'])
let pending = null
let checking = false
let destination = null
const syncing = new Map()
function key(id) { return 'qandaProfileSetup:' + id }
function localSeen(storage, id) { try { return storage.get(key(id)) || {} } catch (_) { return {} } }
function current(identity) { return auth.getAuth(createWxStorageAdapter()).token === identity.token }
function start() { const identity = auth.getAuth(createWxStorageAdapter()); pending = identity.token ? { identity, force: true } : null }
function onLogin(identity) { pending = { identity, force: false }; destination = null }
function syncSeen(identity) {
  if (!identity.token || !current(identity)) return Promise.resolve()
  const storage = createWxStorageAdapter(), record = localSeen(storage, identity.userId)
  if (!record.seen || !record.pending) return Promise.resolve()
  if (syncing.has(identity.token)) return syncing.get(identity.token)
  const request = api.request('POST', '/me/profile-setup/acknowledgement', {}, { token: identity.token, idempotencyKey: record.commandId })
    .then(result => {
      if (!result.ok || !current(identity)) return
      storage.set(key(identity.userId), { seen: true, pending: false })
      const latest = auth.getAuth(storage)
      auth.saveAuth(storage, Object.assign({}, latest, { profile: Object.assign({}, latest.profile, { profileSetupSeen: true }) }))
    }).catch(() => {}).finally(() => syncing.delete(identity.token))
  syncing.set(identity.token, request)
  return request
}
function markSeen() {
  const storage = createWxStorageAdapter(), identity = auth.getAuth(storage)
  if (!identity.token) return
  const record = localSeen(storage, identity.userId)
  try { storage.set(key(identity.userId), { seen: true, pending: true, commandId: record.commandId || api.uuid() }) } catch (_) { /* The server acknowledgement can still record this visit. */ }
  if (!localSeen(storage, identity.userId).seen) {
    return api.request('POST', '/me/profile-setup/acknowledgement', {}, { token: identity.token, idempotencyKey: api.uuid() }).catch(() => {})
  }
  return syncSeen(identity)
}
function visible(page) {
  const pages = getCurrentPages()
  return !page._pageUnloaded && pages[pages.length - 1] === page
}
async function showPending(page) {
  if (!pending || checking || !SAFE_PAGES.has(page.route) || !visible(page)) return
  const event = pending
  if (!current(event.identity)) { if (pending === event) pending = null; return }
  checking = true
  try {
    if (event.force) {
      await remote.refreshProfile(createWxStorageAdapter(), { force: true })
      event.force = false
    }
    if (pending !== event || !current(event.identity) || !visible(page)) return
    const storage = createWxStorageAdapter(), identity = auth.getAuth(storage)
    pending = null
    if (!needsProfile(identity)) return
    syncSeen(identity)
    if (!identity.profile.profileSetupSeen && !localSeen(storage, identity.userId).seen) {
      destination = { url: '/' + page.route, userId: identity.userId }
      if (page.route === 'page/bank-detail/index' && page.data.subjectId) getApp().setPendingSubjectId(page.data.subjectId)
      navigation.reLaunch({ url: '/page/profile-setup/index' })
    } else {
      wx.showModal({ title: '完善学习资料', content: '填写学院、专业和年级，可以为你匹配更合适的题库。', confirmText: '去填写', cancelText: '稍后再说', success: result => {
        if (result.confirm && current(identity) && visible(page)) navigation.navigateTo({ url: '/page/account/index' })
      } })
    }
  } catch (_) {
    if (pending === event) pending = null
  } finally {
    checking = false
    const top = getCurrentPages().slice(-1)[0]
    if (pending && top) showPending(top)
  }
}
function finishAuthentication() {
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
module.exports = { start, onLogin, showPending, markSeen, syncSeen, finish, finishAuthentication }
