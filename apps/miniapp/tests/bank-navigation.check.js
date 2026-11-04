const assert = require('node:assert/strict')
const fs = require('node:fs')
const filters = require('../miniprogram/repositories/catalog-filters.js')
const api = require('../miniprogram/repositories/api-transport.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const repository = require('../miniprogram/repositories/practice-repository.js')
const { SubjectListViewModel } = require('../miniprogram/viewmodels/subject-list-viewmodel.js')

async function main() {
  let appDefinition, bankDefinition, homeDefinition, target = '', selected = ''
  const values = {}
  const storage = { get: key => values[key], set: (key, value) => { values[key] = value }, remove: key => delete values[key] }
  global.App = value => { appDefinition = value }
  global.Page = value => { bankDefinition = value }
  global.wx = { showToast() {}, switchTab(input) { target = input.url; input.success && input.success({}); input.complete && input.complete({}) } }
  require('../miniprogram/app.js')
  const app = Object.assign({}, appDefinition, { globalData: structuredClone(appDefinition.globalData) })
  global.getApp = () => app
  require('../miniprogram/page/bank-detail/index.js')
  global.Page = value => { homeDefinition = value }
  require('../miniprogram/page/subject-list/index.js')
  const page = Object.assign({}, bankDefinition, {
    data: structuredClone(bankDefinition.data),
    setData(patch) { Object.assign(this.data, patch) },
    getTabBar: () => ({ setSelected: route => { selected = route } })
  })
  const opened = []
  let searched = ''
  page.viewModel = {
    storage, repository,
    load: () => null,
    clearSearch: () => ({ data: { searchKeyword: '', searchActive: false, searchResults: [] } }),
    refreshRemote: async id => { opened.push(['subject', id]); return { data: { catalogLoading: false } } },
    openPublicBank: async id => { opened.push(['bank', id]); return { data: { subjectId: 's', catalogLoading: false } } },
    openBankConfig: async (subject, bank, chapter) => { opened.push(['chapter', subject, bank, chapter]); return null },
    restorePendingPractice: async () => null,
    updateSearch: async keyword => { searched = keyword; return { data: { searchResults: [{ id: 'filtered' }] } } }
  }
  page.loadFilters = async () => null
  const home = Object.assign({}, homeDefinition, { data: {}, setData() {}, viewModel: {} })
  home.data.searchResults = [{ id: 'chapter', kind: 'CHAPTER', subjectId: 's', questionBankId: 'b', chapterId: 'c' }]
  home.viewModel.closeSearch = () => null
  home.handleSearchResultTap({ currentTarget: { dataset: { id: 'chapter' } } })
  assert.equal(target, '/page/bank-detail/index', '搜索结果通过 switchTab 进入题库')
  await page.onShow()
  assert.equal(selected, 'page/bank-detail/index')
  assert.deepEqual(opened, [['bank', 'b'], ['chapter', 's', 'b', 'c']])
  assert.equal(app.globalData.pendingBankTarget, null, '定位目标只消费一次')
  await page.onShow()
  assert.equal(opened.filter(row => row[0] === 'chapter').length, 1, '返回题库不重复打开章节配置')
  app.setPendingSubjectId('another')
  await page.onShow()
  assert.deepEqual(opened.at(-1), ['subject', 'another'])
  assert.equal(page.routeBankId, '', '首页科目定位覆盖之前的分享定位')

  const cold = Object.assign({}, page, { data: structuredClone(bankDefinition.data), hasLoadedOnce: false })
  cold.onLoad({ bankId: 'shared', chapterId: 'shared-chapter' })
  cold.viewModel = page.viewModel
  await cold.onShow()
  assert.deepEqual(opened.at(-2), ['bank', 'shared'], '分享冷启动按公开 ID 读取')
  assert.deepEqual(opened.at(-1), ['chapter', 's', 'shared', 'shared-chapter'])

  filters.save(storage, { collegeId: 'a', grade: 2 })
  filters.save(storage, { majorId: 'm' })
  page.data.searchKeyword = '原关键词'
  page.data.filterColleges = [{ id: '', name: '全部学院' }, { id: 'b', name: '学院乙' }]
  await page.handleCollegeFilter({ detail: { value: '1' } })
  assert.deepEqual(filters.read(storage), { collegeId: 'b', majorId: '', grade: 2 })
  assert.equal(searched, '原关键词', '切筛选后重查当前搜索')
  assert.equal(page.routeBankId, '')
  assert.equal(page.data.searchLoading, false)
  auth.saveAuth(storage, { provider: 'email', userId: 'other', token: 'token' })
  assert.equal(filters.read(storage).collegeId, 'b', '账号切换保留本机选择')
  await page.handleGradeFilter({ detail: { value: '0' } })
  assert.equal(filters.read(storage).grade, null)

  filters.save(storage, { majorId: 'major-b', grade: 2 })
  page.data.filterMajors = [{ id: '', name: '全部专业' }, { id: 'major-b', name: '专业乙' }]
  page.syncFilterToggle()
  assert.equal(page.data.filterToggleEnabled, true)
  await page.handleFilterToggle()
  assert.deepEqual(filters.read(storage), { collegeId: '', majorId: '', grade: null })
  assert.equal(page.data.filterToggleRestore, true)
  assert.equal(searched, '原关键词', '重置保留搜索关键词')
  await page.handleFilterToggle()
  assert.deepEqual(filters.read(storage), { collegeId: 'b', majorId: 'major-b', grade: 2 })
  assert.equal(page.data.filterToggleRestore, false)

  let finishOld
  api.getAll = path => path === '/colleges' ? Promise.resolve({ ok: true, data: [{ id: 'b', name: '乙' }] })
    : new Promise(resolve => { finishOld = resolve })
  filters.save(storage, { majorId: 'old-major' })
  const oldOptions = bankDefinition.loadFilters.call(page)
  await Promise.resolve(); await Promise.resolve()
  filters.save(storage, { collegeId: 'new-college' })
  page.filterRequest++
  finishOld({ ok: true, data: [] })
  await oldOptions
  assert.equal(filters.read(storage).collegeId, 'new-college', '旧分类响应不清除新选择')
  assert.equal(page.data.filterError || '', '')

  const bankMarkup = fs.readFileSync(require.resolve('../miniprogram/page/bank-detail/index.wxml'), 'utf8')
  const homeMarkup = fs.readFileSync(require.resolve('../miniprogram/page/subject-list/index.wxml'), 'utf8')
  assert(bankMarkup.indexOf('catalog-filters') > bankMarkup.indexOf('bk-search'))
  assert(bankMarkup.indexOf('catalog-filters') < bankMarkup.indexOf('class="workbench"'))
  assert.equal((bankMarkup.match(/<picker /g) || []).length, 3)
  assert(!homeMarkup.includes('catalog-filters'))
  assert(!bankMarkup.includes('<page-header'))
  assert(bankMarkup.includes('class="rail"') && bankMarkup.includes('class="panel"'))
  const idle = new SubjectListViewModel({ storage }).openBank().command
  assert.equal(idle.type, 'switchTab')
  console.log('题库导航与筛选通过：原底栏定位、分享章节、一次消费、筛选搜索、迟到响应及首页入口')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
