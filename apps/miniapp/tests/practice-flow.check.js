const assert = require('node:assert/strict')
const { normalizePreferences } = require('../miniprogram/utils/preferences.js')
const { PracticeLayoutViewModel } = require('../miniprogram/viewmodels/practice-layout-viewmodel.js')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const { mapQuestion } = require('../miniprogram/repositories/online-practice.js')
const order = ['tools', 'response', 'info', 'stem']
let saved = { moduleOrder: order, practiceStemPercent: 65, optionOutline: true }, full = false, writes = 0
const storage = { get: () => saved, set(key, value) { if (full) throw new Error('full'); writes++; saved = value } }
assert.equal(normalizePreferences(saved).layoutMode, 'flow')
assert.equal(normalizePreferences({ layoutMode: 'unknown' }).layoutMode, 'flow')
const editor = new PracticeLayoutViewModel({ storage })
assert.deepEqual(editor.load().data.preferences.moduleOrder, order)
assert.equal(editor.getLayoutData().stemPercent, 65)
editor.setPercent(30)
assert.equal(editor.percent, 65, '顺序模式保留备用比例')
editor.toggleMode(); editor.setPercent(70); editor.drop('stem', 0)
editor.toggleMode(); editor.toggleMode()
assert.equal(editor.percent, 70)
assert.deepEqual(editor.order, ['stem', 'tools', 'response', 'info'])
const draft = editor.layoutValue()
let preview = editor.setPreview(true).data
assert.equal(preview.preferences.optionOutline, true, '布局预览沿用选项外框偏好')
assert.equal(preview.editLayout, false)
assert.equal(preview.currentQuestion.options.length, 4)
assert.equal(preview.shouldRevealAnswer, false)
preview = editor.selectOption(1).data
assert.equal(preview.shouldRevealAnswer, true)
assert.equal(preview.currentSelectedAnswerText, 'B')
assert(preview.currentExplanation)
editor.setPreview(false)
assert.deepEqual(editor.layoutValue(), draft)
assert.equal(writes, 0, '预览作答不产生存储记录')
full = true
assert.match(editor.save().command.title, /失败/)
assert.deepEqual(editor.layoutValue(), draft)
assert.equal(saved.practiceStemPercent, 65)
full = false; editor.save()
assert.equal(saved.layoutMode, 'custom')
assert.deepEqual(saved.moduleOrder, draft.moduleOrder)
assert.equal(saved.practiceStemPercent, 70)
editor.reset()
assert.equal(saved.layoutMode, 'custom', '恢复默认仍需保存')
editor.save()
assert.equal(saved.layoutMode, 'flow')
assert.equal(saved.practiceStemPercent, 50)
assert.deepEqual(saved.moduleOrder, ['info', 'stem', 'response', 'tools'])

const multi = mapQuestion({ itemId: 'multi', question: { id: 'multi', type: 'MULTIPLE_CHOICE', stem: '选择甲乙', options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }] } }, { correctAnswer: ['A', 'B'], explanation: 'revealed-only-after-confirm' })
for (const feedback of ['IMMEDIATE', 'AFTER_FINISH']) {
  const session = new PracticeSession({ quiz: { bankId: 'b', questions: [multi] }, mode: 'practice', feedback, preferences: { autoOpenAnalysis: false } })
  session.reset()
  assert.equal(session.getViewData().currentQuestion.isMultiple, true)
  assert.equal(session.getViewData().primaryActionDisabled, feedback === 'IMMEDIATE')
  assert.equal(session.getViewData().primaryActionText, feedback === 'IMMEDIATE' ? '确认答案' : '交卷')
  if (feedback === 'IMMEDIATE') assert.equal(session.goNext(), null, '空多选不能点击确认')
  session.selectOption(0); session.selectOption(1)
  assert.equal(session.getViewData().primaryActionDisabled, false)
  assert.equal(session.getViewData().shouldRevealAnswer, false)
  assert.equal(session.getViewData().currentSelectedAnswerText, '')
  if (feedback === 'IMMEDIATE') {
    session.goNext()
    const data = session.getViewData()
    assert.equal(data.primaryActionText, '交卷')
    assert.equal(data.shouldRevealAnswer, true, '旧自动解析偏好不影响揭晓')
    assert.equal(data.currentSelectedAnswerText, 'A、B')
    assert.equal(data.currentExplanation, 'revealed-only-after-confirm')
  } else {
    assert(!JSON.stringify(session.getViewData()).includes('revealed-only-after-confirm'))
    session.goNext()
    assert.equal(session.getViewData().showSubmitModal, true)
    session.forceSubmit()
    assert.equal(session.getViewData().isCompleted, true, '统一反馈在末题确认全部草稿后交卷')
  }
}

for (const action of ['save', 'confirm']) {
  const model = new PracticeSession({ quiz: { bankId: 'b', questions: [multi, { ...multi, id: 'next' }] }, mode: 'practice', preferences: { swipeDraftAction: action } })
  model.reset()
  const vm = new PracticeViewModel()
  vm.session = model; vm.persistSession = () => {}
  vm.goNext(true)
  assert.equal(model.state.currentIndex, 1, '空多选的主按钮禁用不影响左滑跳过')
}

let definition
const previousPage = global.Page, previousWx = global.wx
global.Page = value => { definition = value }
global.wx = {}
require('../miniprogram/page/practice/index.js')
try {
  const patches = []
  const page = Object.assign({}, definition, { data: structuredClone(definition.data), pageVisible: true, viewModel: {}, setData(patch, done) { patches.push(patch); Object.assign(this.data, patch); if (done) done() }, observeSaveStatus() {}, applyViewModelEffects() {}, scheduleMeasure() {}, clearAutoAdvance() {} })
  page.data.currentQuestion = { isFillBlank: true }
  page.data.currentIndex = 0; page.lastQuestionIndex = 0
  page.flowPosition = 120
  page.createSelectorQuery = () => {
    const query = { select() { return query }, boundingClientRect() { return query }, exec(done) { done([{ top: 100, height: 250 }, { top: 130, height: 600 }, null]) } }
    return query
  }
  page.measurePanes()
  assert.equal(page.flowHeight, 250)
  assert.equal(page.flowStemOffset, 150)
  page.keyboardVisible = true; page.answerFocused = true; page.focusedBlank = { top: 330, height: 36 }
  page.revealFocusedBlank()
  assert.equal(page.data.flowScrollTop, 278, '键盘出现时将底部填空滚入视野')
  page.keyboardVisible = false; page.answerFocused = false; page.keyboardScrollRestore = { flow: 120 }
  page.measurePanes()
  assert.equal(page.data.flowScrollTop, 120, '键盘收起恢复原文位置')
  patches.length = 0
  page.applyViewModelResult({ data: { timerText: '00:01' } })
  assert.deepEqual(patches, [{ timerText: '00:01' }], '新布局计时更新不发送内容或旧解析状态')
} finally { global.Page = previousPage; global.wx = previousWx }
console.log('practice flow passed: preference migration, isolated preview, atomic saving, confirmation, disclosure, keyboard and sparse patches')
