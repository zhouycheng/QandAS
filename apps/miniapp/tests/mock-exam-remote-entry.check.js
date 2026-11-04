const assert = require('node:assert/strict')
const { SubjectListViewModel } = require('../miniprogram/viewmodels/subject-list-viewmodel.js')
const { BankDetailViewModel } = require('../miniprogram/viewmodels/bank-detail-viewmodel.js')
const preferences = require('../miniprogram/repositories/preference-repository.js')
const { timeLimitSeconds } = require('../miniprogram/utils/practice-presets.js')
const vm = new SubjectListViewModel({ repository: new Proxy({}, { get() { throw new Error('进入模拟考不应自动查询和选择题库') } }) })
assert.deepEqual(vm.openMock(), { command: { type: 'switchTab', url: '/page/bank-detail/index', target: { intent: 'test' } } })

async function main() {
  const values = {}
  const storage = { get: key => values[key], set: (key, value) => { values[key] = JSON.parse(JSON.stringify(value)) } }
  preferences.savePreferences(storage, { practicePresets: [{ id: 'reading', name: '背题', mode: 'view', count: 5, duration: 0 }], defaultPracticePresetId: 'reading', practiceOrder: 'order' })
  const saved = JSON.stringify(values)
  let requestedScope
  const banks = [{ id: 'b1', activeQuestionCount: 20 }, { id: 'b2', activeQuestionCount: 45 }]
  const model = new BankDetailViewModel({ storage, repository: {
    getPreferences: () => preferences.getPreferences(storage),
    loadRemoteBanks: async () => ({ items: banks, pageSize: 20, total: 2 }),
    getSubjectDetail: () => ({ id: 'subject', name: '科目' }), getSubjectSummaries: () => [],
    previewRemotePracticeScope: async (_, scope) => { requestedScope = scope; return { availableCount: 65, selectedCount: 65, selectionKey: 'all-questions' } }
  } })
  model.buildViewData = () => ({})
  model.mockSelection = true
  await model.openSubjectConfig('subject')
  const result = await model.confirmConfig()
  const route = new URL(result.command.payload.url, 'https://example.test').searchParams
  assert.equal(route.get('mode'), 'test')
  assert.equal(route.get('duration'), '45')
  assert.equal(timeLimitSeconds(Object.fromEntries(route)), 2700)
  assert.equal(route.get('count'), '65')
  assert.equal(route.get('countAll'), '1')
  assert.equal(route.get('bankIds'), 'b1,b2')
  assert.deepEqual(requestedScope.questionBankIds, ['b1', 'b2'])
  assert.equal(requestedScope.count, 1000, '预览完整范围，不使用默认预设的五题')
  assert.equal(requestedScope.order, 'RANDOM')
  assert.equal(result.data.configSheetVisible, false)
  assert.equal(model.mockSelection, false)
  assert.equal(JSON.stringify(values), saved, '直接模拟考不修改用户预设')

  let definition, configured = 0, confirmed = 0, presented = 0, refreshed = 0, resolveOpen
  const switched = [], opened = []
  global.Page = page => { definition = page }
  global.wx = { showLoading() {}, hideLoading() {}, showToast() {} }
  require('../miniprogram/page/bank-detail/index.js')
  const page = { ...definition, data: { subjectId: 'subject', railMode: 'subject' }, viewModel: {
    mockSelection: true, sheetTarget: { type: 'subject' },
    switchSubject(id) { switched.push(id); return { data: { subjectId: id, railMode: 'subject' } } },
    openSubjectConfig(id) { opened.push(['subject', id]); return new Promise(resolve => { resolveOpen = resolve }) },
    openBankConfig(...args) { opened.push(['chapter', ...args]); return { data: { configSheetVisible: true } } },
    refreshSheetScope() { configured++; throw new Error('直接开考不能打开配置') },
    confirmConfig: async () => { confirmed++; return { data: { configSheetVisible: false } } }
  }, refreshCatalog() { refreshed++ }, applyViewModelResult(result) {
    if (result && result.data) {
      if (result.data.configSheetVisible) presented++
      Object.assign(this.data, result.data)
    }
  } }
  const subjectTap = id => page.handleSubjectSwitch({ currentTarget: { dataset: { subjectId: id } } })
  subjectTap('subject')
  assert.equal(opened.length, 0, '点击当前科目保留章节选择页')
  subjectTap('another')
  assert.deepEqual(switched, ['another'], '侧栏切换科目并加载对应章节')
  assert.equal(page.data.subjectId, 'another')
  assert.equal(page.routeSubjectId, 'another')
  assert.equal(refreshed, 1)
  assert.equal(page.viewModel.mockSelection, true, '切换科目保留模拟考选择状态')
  subjectTap('another')
  assert.equal(refreshed, 1, '重复点击当前科目保留当前章节列表')
  page.data.railMode = 'recent'
  subjectTap('another')
  assert.equal(page.data.railMode, 'subject', '从最近在刷切回科目章节列表')
  assert.equal(opened.length, 0)
  assert.equal(confirmed, 0, '侧栏操作只选择科目')

  const pending = page.handleStatTap()
  await page.handleStatTap()
  resolveOpen({ data: { configSheetVisible: true } })
  await pending
  assert.deepEqual(opened, [['subject', 'another']], '顶部整科卡片使用当前科目开考')
  assert.equal(confirmed, 1, '重复点击整科卡片只开始一次')
  await page.handleBankOpen({ detail: { bank: { bankId: 'b1', chapterId: 'c1' } } })
  await page.handleSearchResultTap({ currentTarget: { dataset: { subjectId: 'subject', bankId: 'b2', chapterId: 'c2' } } })
  assert.deepEqual(opened.slice(1), [['chapter', 'another', 'b1', 'c1'], ['chapter', 'subject', 'b2', 'c2']], '章节与搜索结果按选中范围开考')
  assert.equal(confirmed, 3)
  assert.equal(configured, 0)
  assert.equal(presented, 0, '中间配置状态不投影到页面')
  delete global.Page; delete global.wx
  console.log('首页模拟考：科目切换、章节与整科开考、全部题目、45 分钟、预设隔离及重复点击保护通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
