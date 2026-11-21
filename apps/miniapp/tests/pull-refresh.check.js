const assert = require('node:assert/strict')
const fs = require('node:fs')
const { withPageLifecycle } = require('../miniprogram/utils/page-lifecycle.js')
const prior = { Page: global.Page, wx: global.wx, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout }
let stopped = 0
const timers = new Map()
let timerId = 0
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function instance(definition) {
  return Object.assign({}, definition, { data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch) } })
}
async function main() {
  global.wx = { stopPullDownRefresh() { stopped++ }, showToast() {} }
  global.setTimeout = fn => { timers.set(++timerId, fn); return timerId }
  global.clearTimeout = id => timers.delete(id)
  try {
    for (const name of ['subject-list', 'bank-detail', 'stats', 'my']) {
      let definition
      global.Page = value => { definition = value }
      require('../miniprogram/page/' + name + '/index.js')
      const page = instance(definition)
      const gate = deferred()
      let requests = 0
      page.viewModel = { refreshRemote(options) { assert.equal(options.force, true); requests++; return gate.promise } }
      page.refresh = options => page.viewModel.refreshRemote(options)
      page.loadFilters = () => Promise.resolve()
      page.handleRetryLoad = () => page.viewModel.refreshRemote({ force: true })
      if (name === 'bank-detail') {
        let filters = 0, catalog = 0
        const retry = instance(definition)
        retry.loadFilters = () => { filters++ }
        retry.handleRetryLoad = () => { catalog++ }
        retry.data.catalogError = '服务暂不可用'
        retry.data.filterError = '服务暂不可用'
        await retry.handleCatalogErrorRetry()
        assert.deepEqual([filters, catalog], [1, 1])
        retry.data.filterError = ''
        await retry.handleCatalogErrorRetry()
        assert.deepEqual([filters, catalog], [1, 2])
      }
      const pending = page.onPullDownRefresh()
      assert.equal(page.data.pullRefreshing, true, name + ' 立即反馈刷新中')
      assert.match(page.data.pullRefreshMessage, /正在刷新/)
      assert.equal(page.onPullDownRefresh(), pending, name + ' 重复手势复用同轮请求')
      await Promise.resolve()
      assert.equal(requests, 1)
      gate.resolve({ data: {} })
      await pending
      assert.equal(page.data.pullRefreshing, false)
      assert.equal(page.data.pullRefreshState, 'success')
      assert.match(page.data.pullRefreshMessage, /已刷新 \d{2}:\d{2}/)
      const file = fs.readFileSync(require.resolve('../miniprogram/page/' + name + '/index.wxml'), 'utf8')
      assert(name === 'bank-detail' ? file.includes('pullRefreshMessage') : file.includes('templates/refresh-status.wxml'), name + ' 使用统一可见提示')
    }
    assert.equal(stopped, 4)
    const gate = deferred()
    const page = instance(withPageLifecycle({ data: {}, onPullDownRefresh() { return gate.promise } }))
    const pending = page.onPullDownRefresh()
    await Promise.resolve()
    page.onHide()
    gate.resolve()
    await pending
    assert.equal(page.data.pullRefreshState, '', '离开页面后的迟到结果不重新弹出提示')
    assert.equal(page.data.pullRefreshing, false)
    const failed = instance(withPageLifecycle({ data: {}, onPullDownRefresh() { return Promise.reject(new Error('网络失败')) } }))
    await failed.onPullDownRefresh()
    assert.equal(failed.data.pullRefreshState, 'error')
    assert.match(failed.data.pullRefreshMessage, /重试/)
    const partial = instance(withPageLifecycle({ data: {}, onPullDownRefresh() {}, getRefreshError() { return '部分读取失败' } }))
    await partial.onPullDownRefresh()
    assert.equal(partial.data.pullRefreshState, 'error', '已捕获的区域错误不能被显示为刷新成功')
    const bank = fs.readFileSync(require.resolve('../miniprogram/page/bank-detail/index.wxml'), 'utf8')
    assert.equal((bank.match(/bindrefresherrefresh="onPullDownRefresh"/g) || []).length, 1, '只有题库右栏可触发刷新')
    assert(bank.includes('wx:if="{{filterError && !catalogError}}"'), '列表和筛选同时失败时只显示列表重试入口')
    assert.match(bank, /class="panel"[^>]*bindrefresherrefresh=/)
    assert.doesNotMatch(bank, /class="rail"[^>]*refresher-/)
    assert.equal(require('../miniprogram/page/bank-detail/index.json').enablePullDownRefresh, false)
    console.log('四个主页下拉刷新通过：即时反馈、真实完成、失败、重复合并、离页清理及题库滚动入口')
  } finally { Object.assign(global, prior) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
