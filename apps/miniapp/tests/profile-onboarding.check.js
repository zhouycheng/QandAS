const assert = require('node:assert/strict')
const auth = require('../miniprogram/repositories/auth-repository.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const api = require('../miniprogram/repositories/api-transport.js')
const { createWxStorageAdapter } = require('../miniprogram/utils/wx-storage.js')
const records = new Map(), routes = [], modals = []
let pages = [], failAck = true, refreshes = 0, pickedSubject = ''
global.wx = {
  getStorageSync: k => records.get(k), setStorageSync: (k, v) => records.set(k, v), removeStorageSync: k => records.delete(k),
  reLaunch: options => { routes.push(options.url); if (options.success) options.success() },
  navigateTo: options => { routes.push(options.url); if (options.success) options.success() },
  showModal: options => modals.push(options), showToast() {}, navigateBack: options => routes.push('back:' + options.delta)
}
global.getCurrentPages = () => pages
global.getApp = () => ({ setPendingSubjectId: id => { pickedSubject = id } })
const storage = createWxStorageAdapter()
const onboarding = require('../miniprogram/utils/profile-onboarding.js')
const page = { route: 'page/bank-detail/index', data: { subjectId: 'subject' } }
const identity = (id='one', complete=false, seen=false) => ({ provider: 'email', userId: id, token: id + '-token', nickname: '同学', profile: { profileComplete: complete, profileSetupSeen: seen } })
const realRefresh = remote.refreshProfile, realRequest = api.request
api.request = async () => ({ ok: !failAck })
remote.refreshProfile = async () => { refreshes++; return {} }
async function run() {
  auth.saveAuth(storage, identity()); pages = [page]
  onboarding.start(); await onboarding.showPending(page)
  assert.deepEqual(routes, ['/page/profile-setup/index'])
  assert.equal(refreshes, 1); assert.equal(pickedSubject, 'subject')
  await onboarding.markSeen()
  assert.equal(records.get('qandaProfileSetup:one').pending, true)
  records.set('qandaPendingPractice', { bankId: 'pending-bank' })
  onboarding.finish()
  assert.equal(routes.at(-1), '/page/bank-detail/index')
  assert.equal(records.get('qandaPendingPractice').bankId, 'pending-bank')
  await onboarding.showPending(page); assert.equal(modals.length, 0, 'skip does not enqueue another prompt')
  onboarding.start(); await onboarding.showPending(page)
  assert.equal(modals.length, 1, 'next cold start uses a modal even before acknowledgement sync succeeds')
  modals[0].success({ confirm: false })
  await onboarding.showPending(page); assert.equal(modals.length, 1)
  await onboarding.syncSeen(auth.getAuth(storage))
  failAck = false; await onboarding.syncSeen(auth.getAuth(storage))
  assert.equal(records.get('qandaProfileSetup:one').pending, false)
  assert.equal(auth.getAuth(storage).profile.profileSetupSeen, true)
  onboarding.onLogin(auth.getAuth(storage)); await onboarding.showPending(page)
  assert.equal(modals.length, 2)
  modals[1].success({ confirm: true }); assert.equal(routes.at(-1), '/page/account/index')
  auth.saveAuth(storage, identity('two')); onboarding.onLogin(auth.getAuth(storage))
  const practice = { route: 'page/practice/index' }; pages = [practice]
  await onboarding.showPending(practice); assert.notEqual(routes.at(-1), '/page/profile-setup/index')
  pages = [page]; await onboarding.showPending(page); assert.equal(routes.at(-1), '/page/profile-setup/index')
  auth.saveAuth(storage, identity('complete', true)); onboarding.onLogin(auth.getAuth(storage))
  const count = routes.length; await onboarding.showPending(page); assert.equal(routes.length, count)
  remote.refreshProfile = async () => { throw new Error('offline') }
  auth.saveAuth(storage, identity('offline')); onboarding.start(); await onboarding.showPending(page)
  assert.equal(routes.length, count, 'offline reads do not block browsing')
  let resolve
  remote.refreshProfile = () => new Promise(done => { resolve = done })
  auth.saveAuth(storage, identity('stale')); onboarding.start()
  const stale = onboarding.showPending(page)
  auth.saveAuth(storage, identity('switched', true)); onboarding.onLogin(auth.getAuth(storage))
  resolve({}); await stale; await Promise.resolve()
  assert.equal(routes.length, count, 'old account callbacks cannot open a setup page')
  let definition
  global.Page = value => { definition = value }
  require('../miniprogram/page/profile-setup/index.js')
  const setup = Object.assign({}, definition, { data: { loading: false, loadError: '', saving: false }, token: 'switched-token', setData(patch) { Object.assign(this.data, patch) } })
  setup.viewModel = { pending: { collegeId: 'college', majorId: null, currentGrade: 1 }, readAuth: () => auth.getAuth(storage) }
  setup.updateCanContinue(); assert.equal(setup.data.canContinue, false)
  setup.viewModel.pending.majorId = 'major'; setup.updateCanContinue(); assert.equal(setup.data.canContinue, true)
  setup.data.saving = true; setup.updateCanContinue(); assert.equal(setup.data.canContinue, false)
  setup.data.saving = false; setup.updateCanContinue()
  let saveCount = 0, saveDone
  setup.viewModel.save = () => { saveCount++; return new Promise(done => { saveDone = done }) }
  const saving = setup.handleSaveTap(); setup.handleSaveTap(); assert.equal(saveCount, 1)
  pages = [setup]
  auth.saveAuth(storage, identity('another', true)); saveDone({ command: { type: 'profile-complete' } }); await saving
  assert.equal(routes.length, count, 'old account saves cannot navigate after an account switch')
  setup.token = auth.getAuth(storage).token
  setup.data.canContinue = true
  setup.viewModel.refreshRemote = async () => ({ data: { profile: { version: 2 } } })
  setup.viewModel.save = async () => { throw Object.assign(new Error('资料已更新，请重新确认'), { statusCode: 409 }) }
  const choice = Object.assign({}, setup.viewModel.pending)
  await setup.handleSaveTap()
  assert.deepEqual(setup.viewModel.pending, choice, 'version conflicts retain field choices')
  assert.equal(routes.length, count, 'a version conflict requires confirmation instead of navigating away')
  pages = [page, { route: 'page/login/index' }, { route: 'page/register/index' }]
  onboarding.finishAuthentication()
  assert.equal(routes.at(-1), 'back:2', 'registration skips the login page and reaches the business entry')
  pages = [{ route: 'page/register/index' }]
  onboarding.finishAuthentication()
  assert.equal(routes.at(-1), '/page/subject-list/index', 'direct registration falls back to home after success')
  console.log('profile onboarding: first visit, skip, reminder, retry, safe pages, identity isolation and save locking passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { remote.refreshProfile = realRefresh; api.request = realRequest })
