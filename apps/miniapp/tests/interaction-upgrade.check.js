const assert = require('node:assert/strict')
const { allocateHeights, normalizeStemPercent, normalizeOrder, stemPercentAt } = require('../miniprogram/utils/practice-layout.js')
const preferences = require('../miniprogram/repositories/preference-repository.js')
const { normalizePracticeOptions } = require('../miniprogram/utils/preferences.js')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const { PracticeLayoutViewModel } = require('../miniprogram/viewmodels/practice-layout-viewmodel.js')
const { BankDetailViewModel } = require('../miniprogram/viewmodels/bank-detail-viewmodel.js')
const { PracticePresetsViewModel } = require('../miniprogram/viewmodels/practice-presets-viewmodel.js')
const { SettingsViewModel } = require('../miniprogram/viewmodels/settings-viewmodel.js')
const { serializeSession, normalizeSession } = require('../miniprogram/models/practice-session-state.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const api = require('../miniprogram/repositories/api-transport.js')
function memory() {
  const data = {}
  return { full: false, get: key => data[key] && JSON.parse(JSON.stringify(data[key])), set(key, value) { if (this.full) throw new Error('存储已满'); data[key] = JSON.parse(JSON.stringify(value)) } }
}
function question(id, material) { return { id, type: 'MULTIPLE_CHOICE', isMultiple: true, stem: '选择甲和乙', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKeys: ['A', 'B'], material } }
function session(action, questions) {
  const model = new PracticeSession({ quiz: { bankId: 'b', questions: questions || [question('a'), question('b')] }, mode: 'practice', preferences: { swipeDraftAction: action } })
  model.reset()
  return model
}
async function main() {
  for (const ratio of [30, 50, 70]) {
    const short = allocateHeights({ height: 400, stemPercent: ratio, contentHeights: { stem: 12, response: 20 } }).heights
    const long = allocateHeights({ height: 400, stemPercent: ratio, contentHeights: { stem: 1000, response: 2000 } }).heights
    assert.deepEqual(short, long, '内容长度不改变区域起点')
    assert.equal(short.stem, ratio * 4)
    assert.equal(short.response, (100 - ratio) * 4)
    for (const height of [1, 101, 279, 640]) assert.equal(Object.values(allocateHeights({ height, stemPercent: ratio }).heights).reduce((a, b) => a + b, 0), height)
  }
  assert.equal(stemPercentAt(100, 100, 200), 70)
  assert.equal(stemPercentAt(200, 100, 200), 50)
  assert.equal(stemPercentAt(300, 100, 200), 30)
  assert.equal(stemPercentAt(-100, 100, 200), 70)
  assert.equal(stemPercentAt(500, 100, 200), 30)
  assert.equal(stemPercentAt(123, 100, 200), 65)
  assert.equal(stemPercentAt(100, 100, 0), null)
  assert.equal(stemPercentAt(NaN, 100, 200), null)
  assert.equal(normalizeStemPercent(31), 50)
  const store = memory()
  const settings = new SettingsViewModel({ storage: store })
  const swipeSwitch = data => data.switches.find(item => item.key === 'swipeDraftAction')
  assert.equal(swipeSwitch(settings.load().data).value, false)
  preferences.savePreferences(store, { swipeDraftAction: 'confirm' })
  assert.equal(swipeSwitch(settings.load().data).value, true, '兼容已保存的确认设置')
  assert.equal(settings.load().data.choices.some(item => item.key === 'swipeDraftAction'), false)
  store.full = true
  assert.equal(swipeSwitch(settings.toggleSwitch('swipeDraftAction', false).data).value, true, '失败后恢复已保存的开关状态')
  store.full = false
  settings.toggleSwitch('swipeDraftAction', false)
  assert.equal(preferences.getPreferences(store).swipeDraftAction, 'save')
  settings.toggleSwitch('swipeDraftAction', true)
  assert.equal(preferences.getPreferences(store).swipeDraftAction, 'confirm')
  settings.toggleSwitch('swipeEnabled', false)
  assert.equal(swipeSwitch(settings.load().data).disabled, true)
  settings.toggleSwitch('swipeDraftAction', false)
  assert.equal(preferences.getPreferences(store).swipeDraftAction, 'confirm', '总开关关闭时不能修改子选项')
  settings.toggleSwitch('swipeEnabled', true)
  assert.equal(swipeSwitch(settings.load().data).disabled, false)
  assert.equal(swipeSwitch(settings.load().data).value, true, '重新开启后保留确认偏好')
  assert.equal(normalizePracticeOptions({ swipeEnabled: false }, { swipeEnabled: true }).swipeEnabled, false, '已有练习保留关闭状态')
  assert.equal(normalizePracticeOptions({}, { swipeEnabled: false }).swipeEnabled, false, '旧快照按当前设置补齐')
  const disabledSession = session('confirm')
  disabledSession.meta.config.swipeEnabled = false
  assert.equal(normalizeSession(serializeSession(disabledSession.getPersistedState())).config.swipeEnabled, false)
  assert.equal(preferences.getPreferences({ get: () => ({ practiceStemPercent: 40 }) }).practiceStemPercent, 40)
  assert.equal(preferences.getPreferences({ get: () => ({ practiceStemPercent: 40 }) }).practiceStemPercent, 40, '保留已保存的题干比例')
  assert.deepEqual(normalizeOrder(['tools', 'analysis', 'stem', 'info', 'response']), ['tools', 'stem', 'info', 'response'], '移除解析时保留其他模块的顺序')
  const layout = new PracticeLayoutViewModel({ storage: store })
  layout.load(); layout.toggleMode(); layout.setPercent(70)
  assert.equal(layout.getLayoutData().layoutDirty, true)
  assert.equal(preferences.getPreferences(store).practiceStemPercent, 50)
  store.full = true; layout.save()
  assert.equal(layout.getLayoutData().stemPercent, 70)
  assert.equal(layout.getLayoutData().layoutDirty, true)
  store.full = false; layout.save()
  assert.equal(preferences.getPreferences(store).practiceStemPercent, 70)
  preferences.resetPreferences(store)
  assert.equal(preferences.getPreferences(store).practiceStemPercent, 70)
  layout.setPercent(50)
  layout.setHeight(600)
  assert.deepEqual(layout.getLayoutData().paneHeights, { material: 0, stem: 300, response: 300 })
  layout.save()
  assert.equal(preferences.getPreferences(store).practiceStemPercent, 50)
  layout.reset(); layout.save()
  assert.equal(preferences.getPreferences(store).practiceStemPercent, 50)

  for (const action of ['save', 'confirm']) {
    const vm = new PracticeViewModel({ storage: store })
    vm.session = session(action)
    vm.session.selectOption(0)
    vm.persistSession = () => {}
    vm.goNext(true)
    assert.equal(vm.session.state.currentIndex, action === 'save' ? 1 : 0)
    assert.equal(vm.session.state.answers[0].confirmed, action === 'confirm')
    vm.goPrev()
    assert.deepEqual(vm.session.state.selectedKeys, ['A'])
    const saved = normalizeSession(serializeSession(vm.session.getPersistedState()))
    assert.equal(saved.config.swipeDraftAction, action)
    assert.equal(normalizePracticeOptions(saved.config, { swipeDraftAction: action === 'save' ? 'confirm' : 'save' }).swipeDraftAction, action)
    vm.persistSession = () => { throw new Error('存储已满') }
    assert.match(vm.goNext(true).command.title, /存储/)
    assert.equal(vm.session.state.currentIndex, 0)
  }
  assert.equal(normalizePracticeOptions({}, { swipeDraftAction: 'confirm' }).swipeDraftAction, 'confirm')
  const m1 = { id: 'm1', revisionId: 'r1', passage: '原文' }, m2 = { id: 'm2', revisionId: 'r2', passage: '另一原文' }
  const reading = session('save', [question('a', m1), question('b', m2), question('c', m1)])
  assert.equal(reading.getViewData().readingGroupTotal, 2, '只统计本卷实际包含的小题')
  reading.showQuestionAtIndex(2)
  assert.equal(reading.getViewData().readingGroupNumber, 2, '随机题序按材料修订识别题组')

  const bank = new BankDetailViewModel({ storage: store })
  bank.buildViewData = () => ({})
  bank.repository = { ...bank.repository, getSubjectSummaries: () => [], getSubjectDetail: () => null }
  bank.sheetTarget = { type: 'bank', bankId: 'b', questionCount: 8 }
  bank.buildConfigOpenResult()
  const initialCount = preferences.getPreferences(store).practicePresets.length
  store.full = true
  const reusedDefault = bank.saveSheetPreset()
  assert.equal(reusedDefault.command.title, '该配置已存在')
  assert.equal(reusedDefault.data.sheetPresetName, '日常练习')
  assert.equal(preferences.getPreferences(store).practicePresets.length, initialCount, '复用已有项无需写入存储')
  bank.selectDuration(10)
  store.full = true
  assert.match(bank.saveSheetPreset().command.title, /存储/)
  assert.equal(bank.sheet.count, 20, '保存失败保留当前配置')
  store.full = false; bank.saveSheetPreset()
  const savedPreset = preferences.getPreferences(store).practicePresets.at(-1)
  assert.equal(savedPreset.name, '练习·即时反馈·顺序 - 全部 - 10分钟')
  assert.equal(bank.buildSheetData().sheetPresetName, savedPreset.name)
  assert.equal(savedPreset.count, 20, '当前只有八题也保存请求题量二十')
  assert.equal(preferences.getPreferences(store).defaultPracticePresetId, 'daily')
  const renamer = new PracticePresetsViewModel({ storage: store })
  renamer.edit(savedPreset.id); renamer.change('name', '我的复习'); renamer.save(false)
  const beforeRepeat = preferences.getPreferences(store).practicePresets.length
  for (let i = 0; i < 5; i++) {
    const duplicate = bank.saveSheetPreset()
    assert.equal(duplicate.command.title, '该配置已存在')
    assert.equal(duplicate.data.sheetPresetName, '我的复习', '按配置复用并保留自定义名称')
    assert.equal(bank.sheet.presetId, savedPreset.id)
  }
  assert.equal(preferences.getPreferences(store).practicePresets.length, beforeRepeat, '连续点击不创建重复项')
  bank.setSheetCount('ALL'); bank.saveSheetPreset()
  assert.equal(preferences.getPreferences(store).practicePresets.at(-1).count, 'ALL')

  bank.sheetTarget.questionCount = 80
  for (const [count, tier] of [[10, 1], [20, 2], [40, 3]]) {
    bank.setSheetCount(count); bank.setSheetMode('test'); bank.selectDuration(20)
    bank.saveSheetPreset()
    assert.equal(preferences.getPreferences(store).practicePresets.at(-1).name, `模拟考 - ${tier}档 - 20分钟`)
  }
  bank.setSheetCount('ALL'); bank.setSheetMode('view'); bank.saveSheetPreset()
  assert.equal(preferences.getPreferences(store).practicePresets.at(-1).name, '背题 - 全部 - 不限时')
  const originalRequest = api.request
  store.set('qandaAuth', { provider: 'email', userId: 'fixture', token: 'fixture' })
  let reply = { items: [{ id: 'old', version: 1 }, { id: 'new', version: 1 }], total: 2 }
  let requests = 0
  api.request = async () => { requests++; return { ok: true, data: reply } }
  try {
    remote.enable(true)
    await remote.refreshAnnouncements(store, { force: true })
    reply = { items: [{ id: 'replacement', version: 2, pinned: true }], total: 2 }
    await remote.refreshAnnouncements(store, { pageSize: 1, force: true })
    assert.equal(remote.getAnnouncementPreview(store).id, 'replacement')
    assert.equal(remote.getAnnouncements(store)[0].id, 'replacement', '新置顶项不会被旧列表截断')
    reply = { items: [{ id: 'replacement', version: 2, pinned: true }, { id: 'other' }], total: 2 }
    const before = requests
    await remote.refreshAnnouncements(store, {})
    assert.equal(requests, before + 1, '预览更新使旧第一页缓存失效')
    assert.deepEqual(remote.getAnnouncements(store).map(x => x.id), ['replacement', 'other'])
    reply = { items: [], total: 0 }
    await remote.refreshAnnouncements(store, { pageSize: 1, force: true })
    assert.equal(remote.getAnnouncementPreview(store), null)
    assert.deepEqual(remote.getAnnouncements(store), [], '删除公告后不显示旧内容')
    store.set('qandaAuth', { provider: 'email', userId: 'another', token: 'another' })
    assert.deepEqual(remote.getAnnouncements(store), [], '切换账号隔离公告状态')
  } finally { api.request = originalRequest; remote.enable(false) }

  const oldPage = global.Page, oldWx = global.wx
  let definition
  global.Page = value => { definition = value }
  global.wx = { getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }) }
  require('../miniprogram/page/practice/index.js')
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)), pageVisible: true,
    setData(patch, done) { Object.assign(this.data, patch); if (done) done() },
    viewModel: { tickElapsed: () => ({ data: { elapsedText: '00:12' } }) },
    observeSaveStatus() {}, applyViewModelEffects() {}, scheduleMeasure() { throw new Error('计时不应重新测量') }
  })
  const oldInterval = global.setInterval, oldClear = global.clearInterval
  let tick, clears = 0
  global.setInterval = fn => { tick = fn; return 17 }
  global.clearInterval = () => { clears++ }
  try {
    page.data.questions = [{ id: 'a' }]
    page.data.feedback = 'IMMEDIATE'
    assert.equal(page.canSwipe(), true)
    page.data.preferences.swipeEnabled = false
    assert.equal(page.canSwipe(), false)
    page.onQuestionTouchStart({ touches: [{ clientX: 200, clientY: 100 }] })
    assert.equal(page.swipeStart, null, '关闭时不启动手势')
    page.data.preferences.swipeEnabled = true
    page.onTextSelection(); assert.equal(page.canSwipe(), false)
    page.onQuestionTap(); assert.equal(page.canSwipe(), true)
    page.startElapsedTimer(); tick()
    assert.equal(page.data.elapsedText, '00:12')
    page.stopElapsedTimer(); assert.equal(clears, 1)
    page.scheduleMeasure = () => {}
    page.data.currentQuestion = { material: m1 }
    page.data.readingOpen = true; page.data.readingRatio = .9
    page.lastQuestionIndex = 0
    page.applyViewModelResult({ data: { currentIndex: 1, currentQuestion: { material: m1 } } })
    assert.equal(page.data.readingOpen, true); assert.equal(page.data.readingRatio, .9)
    page.applyViewModelResult({ data: { currentIndex: 2, currentQuestion: { material: m2 } } })
    assert.equal(page.data.readingOpen, false); assert.equal(page.data.readingRatio, .65)
    let advances = 0
    page.viewModel.goNext = () => { advances++ }
    page.data.isLastQuestion = true; page.showHint = () => {}
    page.swipeStart = { x: 200, y: 100, at: Date.now() }
    page.onQuestionTouchEnd({ changedTouches: [{ clientX: 100, clientY: 100 }] })
    assert.equal(advances, 0, '末题左滑不确认、不交卷')
  } finally { global.setInterval = oldInterval; global.clearInterval = oldClear; global.Page = oldPage; global.wx = oldWx }
  console.log('交互升级通过：固定分区、比例保存、两种滑题、阅读组、快捷预设、公告缓存及计时补丁')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
