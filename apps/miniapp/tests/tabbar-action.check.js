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
  const original = repository.getResumableSession
  repository.getResumableSession = () => saved
  for (let i = 0; i < routes.length; i++) {
    component.setSelected(routes[i])
    assert.equal(component.data.continueLabel, i === 1 ? '选择题库' : '跳转题库')
    assert.equal(component.data.continueIcon, i === 1 ? 'play' : i === 0 ? 'arrow-right' : 'arrow-left')
    assert.equal(component.data.continueDisabled, i === 1)
    target = ''; component.handleContinueTap()
    assert.equal(target, i === 1 ? '' : '/page/bank-detail/index')
  }
  saved = { sessionId: 'draft /1' }
  for (const route of routes) {
    component.setSelected(route)
    assert.equal(component.data.continueLabel, '继续答题')
    assert.equal(component.data.continueIcon, 'play')
    assert.equal(component.data.continueDisabled, false)
    component.handleContinueTap()
    assert.equal(target, '/page/practice/index?sessionId=draft%20%2F1')
  }
  repository.getResumableSession = () => { throw new Error('读取失败') }
  component.setSelected(routes[1]);target='';component.handleContinueTap()
  assert.equal(component.data.continueDisabled, true)
  assert.equal(target, '')
  repository.getResumableSession = original

  const storage = createWxStorageAdapter()
  auth.saveAuth(storage, { provider: 'email', userId: 'student', token: 'token' })
  remote.enable(true)
  let recent = null
  let recentList = []
  api.request = async (method, path, query) => ({ ok: true, data: path === '/me/learning-overview' ? { recentSession: recent } : { items: path === '/me/recent-learning' ? recentList : [], total: recentList.length, page: query.page, pageSize: query.pageSize } })
  definition.lifetimes.attached.call(component)
  component.setSelected(routes[1])
  assert.equal(component.data.continueDisabled, true)
  recent = { id: 'cloud-session', questionBankId: 'bank', status: 'IN_PROGRESS' }
  await remote.refresh(storage, 'home', { force: true }); await Promise.resolve()
  assert.equal(component.data.continueLabel, '继续答题', '异步读取云端会话后全局按钮自动刷新')
  assert.equal(component.data.continueDisabled, false)
  recentList = [recent]
  await remote.refresh(storage, 'recent')
  recent = null
  await remote.refresh(storage, 'home', { force: true }); await Promise.resolve()
  assert.equal(component.data.continueLabel, '选择题库')
  assert.equal(component.data.continueDisabled, true, '会话结束后恢复当前页面的空闲状态')
  definition.lifetimes.detached.call(component)
  remote.enable(false)
  console.log('底部动作自检通过：四页空闲状态、全局续答、禁用点击、读取失败及异步会话刷新')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
