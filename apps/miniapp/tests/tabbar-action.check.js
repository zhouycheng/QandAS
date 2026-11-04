const assert = require('node:assert/strict')
const repository = require('../miniprogram/repositories/practice-repository.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const api = require('../miniprogram/repositories/api-transport.js')
const { createWxStorageAdapter } = require('../miniprogram/utils/wx-storage.js')

async function main() {
  let definition, target = '', saved = null
  const values = {}
  const routes = ['page/subject-list/index', 'page/bank-detail/index', 'page/stats/index', 'page/my/index']
  global.Component = value => { definition = value }
  global.Behavior = value => value
  global.getCurrentPages = () => [{ route: routes[0] }]
  global.wx = {
    getStorageSync: key => values[key], setStorageSync: (key, value) => { values[key] = value }, removeStorageSync: key => delete values[key],
    nextTick: fn => Promise.resolve().then(fn),
    navigateTo: input => { target = input.url; input.success({}); input.complete({}) },
    switchTab: input => { target = input.url; input.success({}); input.complete({}) }, showToast() {}
  }
  require('../miniprogram/custom-tab-bar/index.js')
  const component = { data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch) } }
  Object.entries(definition.methods).forEach(([key, method]) => { component[key] = method.bind(component) })
  for (let i = 0; i < routes.length; i++) {
    component.setSelected(routes[i])
    assert.equal(component.data.selected, i)
    target = ''; component.handleTabTap({ currentTarget: { dataset: { index: (i + 1) % 4 } } })
    assert.equal(target, '/' + routes[(i + 1) % 4])
  }

  const { SubjectListViewModel } = require('../miniprogram/viewmodels/subject-list-viewmodel.js')
  const vm = new SubjectListViewModel({ repository: Object.assign({}, repository, {
    getResumableSession: () => saved,
    getScopeMeta: () => ({ title: '课程一' }),
    getAuth: () => ({ loggedIn: true })
  }) })
  assert.equal(vm.buildResumablePractice(), null)
  saved = { sessionId: 'draft /1', config: { bankId: 'bank' } }
  const resume = vm.buildResumablePractice()
  assert.equal(resume.title, '课程一')
  assert.equal(resume.url, '/page/practice/index?sessionId=draft%20%2F1')
  let pageDefinition, result
  global.Page = value => { pageDefinition = value }
  require('../miniprogram/page/subject-list/index.js')
  const page = { viewModel: vm, applyViewModelResult: value => { result = value } }
  pageDefinition.handleContinueTap.call(page)
  assert.equal(result.command.payload.url, resume.url)
  saved = null
  vm.projectRemote = () => ({ lastPractice: null })
  pageDefinition.handleContinueTap.call(page)
  assert.equal(result.data.lastPractice, null, '会话结束后点击会更新入口')

  const storage = createWxStorageAdapter()
  auth.saveAuth(storage, { provider: 'email', userId: 'student', token: 'token' })
  remote.enable(true)
  let recent = null
  let recentList = []
  api.request = async (method, path, query) => ({ ok: true, data: path === '/me/learning-overview' ? { recentSession: recent } : { items: path === '/me/recent-learning' ? recentList : [], total: recentList.length, page: query.page, pageSize: query.pageSize } })
  recent = { id: 'cloud-session', questionBankId: 'bank', status: 'IN_PROGRESS', deviceId: auth.deviceId(storage) }
  await remote.refresh(storage, 'home', { force: true }); await Promise.resolve()
  assert.equal(repository.getResumableSession(storage).sessionId, 'cloud-session')
  recentList = [recent]
  await remote.refresh(storage, 'recent')
  recent = null
  await remote.refresh(storage, 'home', { force: true }); await Promise.resolve()
  assert.equal(repository.getResumableSession(storage), null, '会话结束后不提供续答')

  recent = { id: 'other-device-session', questionBankId: 'bank', status: 'IN_PROGRESS', deviceId: 'other-device' }
  recentList = []
  await remote.refreshOverview(storage, { force: true })
  assert.equal(repository.getResumableSession(storage), null, '其他设备练习不能续写')
  storage.set('qandaOnlineLast:student', 'local')
  storage.set('qandaOnline:student:local', { id: 'local', status: 'IN_PROGRESS', title: '课程练习', route: { bankId: 'bank' } })
  assert.equal(repository.getResumableSession(storage).sessionId, 'local', '离线草稿可恢复')
  assert.equal(repository.getResumableSession(storage).config.title, '课程练习', '续答入口保留快照标题')
  storage.set('qandaOnline:student:local', { id: 'local', status: 'SUBMITTED' })
  assert.equal(repository.getResumableSession(storage), null, '已交卷草稿不能续答')
  auth.saveAuth(storage, { provider: 'email', userId: 'other', token: 'other-token' })
  assert.equal(repository.getResumableSession(storage), null, '切换账号不读取旧草稿')
  remote.enable(false)
  console.log('底栏导航与续答状态检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
