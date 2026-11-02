const assert = require('node:assert/strict')
const fs = require('node:fs')
const { SubjectListViewModel } = require('../miniprogram/viewmodels/subject-list-viewmodel.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const api = require('../miniprogram/repositories/api-transport.js')
const auth = require('../miniprogram/repositories/auth-repository.js')

async function main() {
  const subjects = [{ id: 'empty', name: '空科目', questionCount: 0 }].concat([1,2,3,4].map(i => ({ id: 's'+i, name: '课程'+i, questionCount: i })))
  const values = {}
  const storage = { get: key => values[key], set: (key, value) => { values[key] = value }, remove: key => delete values[key] }
  const calls = []
  const pages = []
  const original = api.request
  api.request = async (method, path, query) => {
    calls.push(path)
    pages.push(query.page)
    return { ok: true, data: { items: subjects.slice(1).slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: 4, page: query.page, pageSize: query.pageSize } }
  }
  remote.enable(true)
  await remote.refresh(storage, 'home')
  assert.deepEqual(calls, ['/subjects'], '游客仅读取公开科目，不请求个人资源')
  assert.equal(remote.getRecommendations(storage).length, 3)
  const feed = new SubjectListViewModel({ storage })
  assert.equal(feed.hasMoreRecommendations(), true)
  await Promise.all([feed.loadMoreRecommendations(), feed.loadMoreRecommendations()])
  assert.deepEqual(pages, [1, 2], '同页并发加载合并为一个请求')
  assert.deepEqual(remote.getRecommendations(storage).map(s => s.id), ['s1', 's2', 's3', 's4'])
  assert.equal(feed.hasMoreRecommendations(), false)
  await feed.loadMoreRecommendations()
  assert.deepEqual(pages, [1, 2], '到达末页后不再请求')
  await remote.refresh(storage, 'home')
  assert.equal(remote.getRecommendations(storage).length, 4, '有效缓存保留已加载页面')
  await remote.refresh(storage, 'home', { force: true })
  assert.equal(remote.getRecommendations(storage).length, 3, '下拉刷新从第一页重新开始')
  const goodRequest = api.request
  api.request = async (method, path, query) => query.page === 2 ? { ok: false, reason: '下一页失败' } : goodRequest(method, path, query)
  await assert.rejects(feed.loadMoreRecommendations(), /下一页失败/)
  assert.equal(remote.getRecommendationPage(storage).page, 1)
  assert.equal(remote.getRecommendations(storage).length, 3, '下一页失败保留已显示的科目')
  api.request = goodRequest
  await feed.loadMoreRecommendations()
  assert.equal(remote.getRecommendations(storage).length, 4, '重试继续加载失败的同一页')
  auth.saveAuth(storage, { provider: 'email', userId: 'student', token: 'token' })
  api.request = async (method, path) => {
    if (path === '/me/recommendations') return { ok: false, reason: '推荐读取失败' }
    return { ok: true, data: path === '/announcements' ? { items: [], total: 0 } : { answeredCount: 2 } }
  }
  await remote.refresh(storage, 'home')
  assert.equal(remote.getOverview(storage).answeredCount, 2, '推荐失败仍保留已读取的学习摘要')
  assert.equal(remote.getResourceState('recommendations', { page: 1, pageSize: 3 }).error, '推荐读取失败')
  let definition, pending = '', destination = ''
  global.Page = value => { definition = value }
  global.getApp = () => ({ setPendingSubjectId: id => { pending = id } })
  global.wx = { switchTab: input => { destination = input.url; assert.equal(pending, 's2'); input.success({}) } }
  require('../miniprogram/page/subject-list/index.js')
  definition.handleViewModelCommand({ type: 'switchTab', url: '/page/bank-detail/index', subjectId: 's2' })
  assert.equal(destination, '/page/bank-detail/index')
  global.wx = { switchTab: input => input.fail({}), showToast() {} }
  definition.handleViewModelCommand({ type: 'switchTab', url: '/page/bank-detail/index', subjectId: 's2' })
  assert.equal(pending, '', '跳转失败清理目标，避免下次手动进题库时误切科目')
  let finish, loads = 0
  const page = { data: { recommendationsHasMore: true, recommendationsLoadingMore: false }, setData(patch) { Object.assign(this.data, patch) }, applyViewModelResult() {}, viewModel: { loadMoreRecommendations: () => { loads++; return new Promise(resolve => { finish = resolve }) } } }
  const loading = definition.handleRecommendationsMore.call(page)
  definition.handleRecommendationsMore.call(page)
  assert.equal(loads, 1, '滚动触底期间阻止重复加载')
  finish(null); await loading
  assert.equal(page.data.recommendationsLoadingMore, false)
  api.request = original
  console.log('首页推荐自检通过：分页追加、触底去重、末页停止、刷新与重试、导航和账号权限')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
