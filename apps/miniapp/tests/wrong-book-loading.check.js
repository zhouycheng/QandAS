const assert = require('node:assert/strict')
const { WrongBookViewModel } = require('../miniprogram/viewmodels/wrong-book-viewmodel.js')
const rows = Array.from({ length: 12 }, (_, i) => ({ questionId: 'q' + i, type: 'SINGLE_CHOICE', stem: '题目' + i, wrongCount: 1 }))
rows[0].createdAt = '2026-11-14T12:00:00'
rows[0].lastPracticedAt = '2026-11-15T12:00:00'
rows[1].createdAt = '2026-11-14T12:00:00'
rows[3].createdAt = 'invalid'
const pages = new Map(), calls = []
const key = options => JSON.stringify([options.kind, options.chip, options.sort, options.subjectId, options.page])
let blocked, rejectPage = false
const repository = {
  getRemoteCollection(storage, options) { return pages.get(key(options)) || { status: 'idle', data: null } },
  getRemoteResourceState() { return {} },
  getRemoteCollectionSummary() { return { total: rows.length, facets: [
    { subjectId: 's1', subjectName: '科目一', questionBankId: 'b1', questionBankName: '第一章', count: 2 },
    { subjectId: 's1', subjectName: '科目一', questionBankId: 'b2', questionBankName: '第二章', count: 3 }
  ], subjectiveFacets: [{ subjectId: 's2', subjectName: '科目二', questionBankId: 'b3', count: 1 }] } },
  async refreshRemote(storage, kind, options) {
    calls.push({ ...options })
    const resource = { status: 'loading', data: (pages.get(key(options)) || {}).data }
    pages.set(key(options), resource)
    if (blocked) await blocked
    if (rejectPage && options.page === 2) { resource.status = 'error'; resource.error = '暂时失败'; return }
    resource.status = 'ready'; resource.error = ''
    resource.data = { total: rows.length, items: rows.slice((options.page - 1) * 5, options.page * 5) }
  }
}
async function main() {
  const vm = new WrongBookViewModel({ repository, storage: {} })
  vm.load({ type: 'wrong' }); await vm.refreshRemote()
  assert.deepEqual(vm.buildViewData().subjectFilters, [{ id: 'all', name: '全部科目' }, { id: 's1', name: '科目一' }, { id: 's2', name: '科目二' }])
  assert.equal(vm.buildViewData().items.length, 5)
  assert.deepEqual(vm.buildViewData().items.slice(0, 4).map(item => item.dateText), ['最近练习 11月15日', '收录于 11月14日', '', ''])
  assert.equal(vm.buildViewData().hasMore, true)
  let release
  blocked = new Promise(resolve => { release = resolve })
  const loading = vm.loadMore()
  assert.strictEqual(vm.loadMore(), loading, '触底事件合并在途请求')
  assert.equal(vm.buildViewData().loadingMore, true)
  assert.equal(vm.buildViewData().items.length, 5, '加载时保留已有题目')
  release(); blocked = null; await loading
  assert.deepEqual(vm.buildViewData().items.map(item => item.id), rows.slice(0, 10).map(item => item.questionId))
  await vm.loadMore()
  assert.equal(vm.buildViewData().items.length, 12)
  assert.equal(vm.buildViewData().hasMore, false)
  assert.equal(vm.loadMore(), null, '全部显示后不再请求')
  await vm.reload()
  assert.equal(vm.buildViewData().items.length, 5, '下拉刷新重读第一页')
  assert.equal(calls[calls.length - 1].force, true)
  pages.delete(key({ ...vm.remoteOptions(), page: 2 }))
  rejectPage = true; await vm.loadMore()
  assert.equal(vm.buildViewData().items.length, 5)
  assert.equal(vm.buildViewData().loadMoreError, '暂时失败')
  rejectPage = false; await vm.loadMore()
  assert.equal(vm.state.page, 2, '失败重试当前页，不跳页')
  assert.equal(vm.buildViewData().items.length, 10)
  vm.setChip('repeat'); await vm.refreshRemote()
  assert.equal(vm.state.page, 1)
  assert.equal(vm.buildViewData().items.length, 5, '切筛选从新范围第一页开始')
  console.log('错题与收藏触底追加、请求去重、下拉刷新、失败重试与筛选重置检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
