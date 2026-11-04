const assert = require('node:assert/strict')
const fs = require('node:fs')
const { SubjectListViewModel } = require('../miniprogram/viewmodels/subject-list-viewmodel.js')

async function main() {
  let identity = { loggedIn: true, userId: 'one', token: 'token' }
  let records = [
    { id: 'p1', questionBankId: 'b1', status: 'SUBMITTED' }, { id: 'p2', questionBankId: 'b2', status: 'SUBMITTED' },
    { id: 'p3', questionBankId: 'b1', status: 'SUBMITTED' }, { id: 'p4', questionBankId: 'b3', status: 'SUBMITTED' }
  ]
  const metas = {
    b1: { bankId: 'b1', title: '基础', subjectId: 's1', description: '数学' },
    b2: { bankId: 'b2', title: '进阶', subjectId: 's1', description: '数学' },
    b3: { bankId: 'b3', title: '语法', subjectId: 's2', description: '英语' }
  }
  let scope, release
  const repository = {
    getAuth: () => identity,
    refreshRemote: async () => {},
    getRemoteRecent: () => records,
    getScopeMeta: id => metas[id],
    loadRemoteBank: async () => {},
    loadRemoteSubject: async () => {},
    previewRemotePracticeScope: async (storage, input) => { scope = input; return { selectedCount: 20, selectionKey: 'key' } }
  }
  const vm = new SubjectListViewModel({ repository, storage: {} })
  const recent = await vm.loadRecentChoices()
  assert.deepEqual(recent.subjects.map(subject => [subject.name, subject.banks.map(bank => bank.name)]), [['数学', ['基础', '进阶']], ['英语', ['语法']]])
  assert.equal(recent.hasHistory, true)
  delete metas.b3
  repository.loadRemoteBank = async (storage, id) => { metas[id] = { bankId: id, title: '语法', subjectId: 's2', description: '' } }
  repository.loadRemoteSubject = async (storage, id) => { assert.equal(id, 's2'); metas.b3.description = '英语' }
  assert.equal((await vm.loadRecentChoices()).subjects[1].name, '英语', '目录信息缺失时补齐科目')
  delete metas.b3
  repository.loadRemoteBank = async () => { throw new Error('网络失败') }
  await assert.rejects(vm.loadRecentChoices(), /网络失败/, '网络失败不显示空历史')
  repository.loadRemoteBank = async () => { throw Object.assign(new Error('题库不存在'), { statusCode: 404 }) }
  assert.deepEqual((await vm.loadRecentChoices()).subjects.map(subject => subject.name), ['数学'], '不可用题库不影响其他选择')
  metas.b3 = { bankId: 'b3', title: '语法', subjectId: 's2', description: '英语' }
  const command = await vm.openNewPractice(recent.subjects[0].banks[1])
  assert.deepEqual(scope, { questionBankId: 'b2', count: 20, completeFirstGroup: true, order: 'SEQUENTIAL', selectionKind: 'NORMAL', collectionChip: 'all' })
  assert.match(command.command.payload.url, /bankId=b2&mode=order&count=20/)
  assert.match(command.command.payload.url, /selectionKey=key/)
  assert.equal((await vm.openNewPractice()).command.url, '/page/bank-detail/index')
  repository.previewRemotePracticeScope = async () => ({ selectedCount: 0 })
  assert.match((await vm.openNewPractice(recent.subjects[0].banks[0])).command.title, /没有可练习/)
  records = []
  assert.deepEqual(await vm.loadRecentChoices(), { subjects: [], hasHistory: false })
  repository.refreshRemote = () => new Promise(resolve => { release = resolve })
  const stale = vm.loadRecentChoices()
  identity = { loggedIn: true, userId: 'two', token: 'other' }
  release(); assert.equal(await stale, null, '账号切换后不显示旧记录')

  let definition, calls = 0, action
  global.Page = value => { definition = value }
  global.wx = { showToast() {} }
  require('../miniprogram/page/subject-list/index.js')
  const page = { data: Object.assign(SubjectListViewModel.getInitialData(), {
    recentSubjects: recent.subjects, recentColumns: [['数学', '英语'], ['基础', '进阶']], recentPickerValue: [0, 0],
    recentSelectedSubjectId: 's1', recentSelectedBankId: 'b1', recentSelectedName: '数学 · 基础', recentLoading: false
  }), recentRevision: 1, setData(patch) { Object.assign(this.data, patch) }, applyViewModelResult(result) { action = result }, viewModel: {
    openNewPractice: choice => { calls++; return Promise.resolve({ choice }) }
  } }
  definition.handleRecentColumnChange.call(page, { detail: { column: 0, value: 1 } })
  assert.deepEqual(page.data.recentColumns[1], ['语法'])
  definition.handleRecentCancel.call(page)
  assert.deepEqual(page.data.recentPickerValue, [0, 0], '取消选择保留已确认的题库')
  definition.handleRecentColumnChange.call(page, { detail: { column: 0, value: 1 } })
  definition.handleRecentSelect.call(page, { detail: { value: [1, 0] } })
  assert.equal(page.data.recentSelectedName, '英语 · 语法')
  await definition.handleNewPractice.call(page)
  assert.equal(action.choice.id, 'b3')
  page.data.recentSubjects = []
  await definition.handleNewPractice.call(page)
  assert.equal(action.choice, undefined, '没有历史时使用题库入口')
  page.data.recentLoading = true
  await definition.handleNewPractice.call(page)
  assert.equal(calls, 2, '加载期间不误判为空历史')
  delete global.Page; delete global.wx

  const markup = fs.readFileSync(require.resolve('../miniprogram/page/subject-list/index.wxml'), 'utf8')
  assert.match(markup, /mode="multiSelector"[^>]*bindcolumnchange="handleRecentColumnChange"/)
  assert.match(markup, /wx:else class="home-create"/)
  const homeCss = fs.readFileSync(require.resolve('../miniprogram/page/subject-list/index.wxss'), 'utf8')
  const bankCss = fs.readFileSync(require.resolve('../miniprogram/page/bank-detail/index.wxss'), 'utf8')
  const listCss = fs.readFileSync(require.resolve('../miniprogram/styles/list-page.wxss'), 'utf8')
  for (const [css, name] of [[homeCss, 'hero-brand'], [bankCss, 'bk-title'], [listCss, 'page-head-title']]) assert.match(css, new RegExp('\\.' + name + '\\s*\\{[^}]*font-size:\\s*var\\(--font-(?:title|display)\\)'))
  assert.match(homeCss, /\.hero\s*\{[^}]*padding:\s*0 36rpx/)
  assert.match(bankCss, /\.bk-head\s*\{[^}]*padding:\s*0 26rpx/)
  assert.match(bankCss, /\.bk-navigation\s*\{[^}]*padding-left:\s*10rpx/)
  assert.match(listCss, /\.page-head\s*\{[^}]*padding:\s*0 36rpx/)
  assert.doesNotMatch((listCss.match(/\.page-head\s*\{[^}]*\}/) || [''])[0], /border-bottom/)
  console.log('首页答题卡片：近期科目与题库联动、创建和空态通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
