const assert = require('assert')
let definition
global.Page = value => { definition = value }
require('../miniprogram/page/subject-list/index.js')
let measure
let opened = 0
const page = Object.assign({}, definition, {
  data: {},
  setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() },
  createSelectorQuery() {
    return { select(selector) { assert.strictEqual(selector, '.search-box'); return this }, boundingClientRect(callback) { measure = callback; return this }, exec() {} }
  }
})
page.updateSearchAnchor(() => { opened++ })
measure({ left: 18, top: 112, width: 290, height: 42, bottom: 154 })
assert.strictEqual(page.data.searchAnchorStyle, 'left: 18px; top: 112px; width: 290px; height: 42px;')
assert.strictEqual(page.data.searchResultsTop, 166)
assert.strictEqual(opened, 1)
page.updateSearchAnchor(() => { opened++ })
const stale = measure
page.updateSearchAnchor(() => { opened++ })
stale({ left: 0, top: 0, width: 1, height: 1, bottom: 1 })
assert.strictEqual(opened, 1)
page._pageUnloaded = true
measure({ left: 0, top: 0, width: 1, height: 1, bottom: 1 })
assert.strictEqual(opened, 1)
console.log('首页搜索定位：保持原框位置、结果间距与迟到测量保护通过')

const { SubjectListViewModel } = require('../miniprogram/viewmodels/subject-list-viewmodel.js')
page.data = SubjectListViewModel.getInitialData()
page.runSearch = () => {}
const select = kind => page.handleSearchKindChange({ currentTarget: { dataset: { kind } } })
select('SUBJECT')
select('BANK')
assert.strictEqual(page.data.searchKind, 'SUBJECT,BANK')
assert.strictEqual(page.data.searchKinds[0].selected, false)
select('SUBJECT')
assert.strictEqual(page.data.searchKind, 'BANK')
select('BANK')
assert.strictEqual(page.data.searchKind, '')
assert.strictEqual(page.data.searchKinds[0].selected, true)
select('QUESTION')
select('')
assert.deepStrictEqual(page.data.searchKinds.filter(item => item.selected).map(item => item.value), [''])
console.log('搜索胶囊：类型多选、全部互斥与最后一项取消检查通过')
