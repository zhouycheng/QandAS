const assert = require('node:assert/strict')
const fs = require('node:fs')
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
  assert.deepEqual(calls, [], '游客首页不请求推荐科目或个人资源')
  await remote.refreshRecommendations(storage)
  assert.equal(remote.getRecommendations(storage).length, 3)
  await Promise.all([remote.refreshRecommendations(storage, { page: 2 }), remote.refreshRecommendations(storage, { page: 2 })])
  assert.deepEqual(pages, [1, 2], '同页并发加载合并为一个请求')
  assert.deepEqual(remote.getRecommendations(storage).map(s => s.id), ['s1', 's2', 's3', 's4'])
  await remote.refreshRecommendations(storage)
  assert.equal(remote.getRecommendations(storage).length, 4, '有效缓存保留已加载页面')
  await remote.refreshRecommendations(storage, { force: true })
  assert.equal(remote.getRecommendations(storage).length, 3, '下拉刷新从第一页重新开始')
  const goodRequest = api.request
  api.request = async (method, path, query) => query.page === 2 ? { ok: false, reason: '下一页失败' } : goodRequest(method, path, query)
  await assert.rejects(remote.refreshRecommendations(storage, { page: 2 }), /下一页失败/)
  assert.equal(remote.getRecommendationPage(storage).page, 1)
  assert.equal(remote.getRecommendations(storage).length, 3, '下一页失败保留已显示的科目')
  api.request = goodRequest
  await remote.refreshRecommendations(storage, { page: 2 })
  assert.equal(remote.getRecommendations(storage).length, 4, '重试继续加载失败的同一页')
  auth.saveAuth(storage, { provider: 'email', userId: 'student', token: 'token' })
  api.request = async (method, path) => {
    if (path === '/subjects') return { ok: false, reason: '推荐读取失败' }
    return { ok: true, data: path === '/announcements' ? { items: [], total: 0 } : { answeredCount: 2 } }
  }
  await remote.refresh(storage, 'home')
  assert.equal(remote.getOverview(storage).answeredCount, 2)
  const markup = fs.readFileSync(require.resolve('../miniprogram/page/subject-list/index.wxml'), 'utf8')
  assert.match(markup, /<view class="sheet">\s*<!-- 考试倒计时/)
  api.request = original
  console.log('首页加载与目录缓存检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
