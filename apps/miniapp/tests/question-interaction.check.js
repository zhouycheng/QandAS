const assert = require('node:assert/strict')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const { mapQuestion } = require('../miniprogram/repositories/online-practice.js')
const { gradeBlanks } = require('../miniprogram/utils/fill-blank.js')
const { serializeSession, normalizeSession } = require('../miniprogram/models/practice-session-state.js')
const { contentBlocks } = require('../miniprogram/utils/rich-content.js')
const { swipeDirection } = require('../miniprogram/utils/question-swipe.js')
const { normalizePreferences, buildPreferenceView } = require('../miniprogram/utils/preferences.js')
assert.equal(normalizePreferences({ showSelfAssessment: false }).showSelfAssessment, undefined)
assert.equal(buildPreferenceView({ showSelfAssessment: false }).switches.some(item => item.key === 'showSelfAssessment'), false)

function question(type, id) {
  return mapQuestion({ itemId: id, question: { id, type, stem: type === 'FILL_BLANK' ? '{{1}} / {{2}}' : '题干', blankCount: 2, contentFormat: 'MARKDOWN', options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }, { key: 'C', content: '丙' }] } }, {
    correctAnswer: type === 'MULTIPLE_CHOICE' ? ['A', 'B'] : ['A'], correctValue: true, referenceAnswer: 'reference-secret', scoringPoints: ['point-secret'], explanation: 'explanation-secret', blanks: [{ answers: ['A'] }, { answers: ['B'] }], blankMatch: { ignoreCase: false, trimWhitespace: true }
  })
}
function session(types, options) {
  const model = new PracticeSession({ quiz: { bankId: 'bank', questions: types.map((type, index) => question(type, `q${index}`)) }, mode: 'practice', ...options })
  model.reset()
  return model
}

const judge = { id: 'judge', type: 'TRUE_FALSE', stem: '判断题', correctValue: false }
const judgeOptions = [{ key: 'true', label: 'A', text: '正确' }, { key: 'false', label: 'B', text: '错误' }]
assert.deepEqual(mapQuestion({ itemId: 'judge-item', question: judge }).options, judgeOptions)
assert.deepEqual(require('../miniprogram/repositories/remote-data-repository.js').mapQuestion(judge).options, judgeOptions)
const judgeSession = new PracticeSession({ quiz: { bankId: 'bank', questions: [mapQuestion({ itemId: 'judge-item', question: judge })] }, mode: 'practice' })
judgeSession.reset(); judgeSession.selectOption(1)
assert.equal(judgeSession.getViewData().isCurrentAnswerCorrect, true, 'B 仍按 false 判题')

for (const fixture of require('../../../packages/content-format/fixtures/blank-grading.json')) {
  assert.equal(gradeBlanks({ blanks: [{ answers: fixture.answers }], blankMatch: fixture }, [fixture.value]), fixture.correct, fixture.name)
}
for (const fixture of require('../../../packages/content-format/fixtures/scoring.json')) {
  const model = session(Array(fixture.objective).fill('SINGLE_CHOICE').concat(Array(fixture.subjective).fill('SHORT_ANSWER')), { feedback: 'AFTER_FINISH' })
  for (let i = 0; i < fixture.correct + fixture.wrong; i++) { model.jumpToQuestion(i); model.selectOption(i < fixture.correct ? 0 : 1) }
  for (let i = fixture.objective; i < model.state.total; i++) { model.jumpToQuestion(i); model.setAnswerText('理解') }
  model.jumpToQuestion(0)
  const result = model.forceSubmit()
  assert.equal(result.data.score, fixture.score)
  assert.equal(result.data.objectiveAccuracyText, fixture.accuracy === null ? '—' : `${Math.round(fixture.accuracy * 1000) / 10}%`)
  assert.equal(result.data.wrongQuestionIds.length, fixture.wrong)
  assert.equal(result.data.resultFilterCounts.unscored, fixture.subjective)
  assert.equal(model.forceSubmit().data.isCompleted, true, '重复交卷保持完成状态')
}

for (const feedback of ['IMMEDIATE', 'AFTER_FINISH']) for (const autoNextWhenCorrect of [false, true]) {
  const model = session(['MULTIPLE_CHOICE', 'FILL_BLANK', 'SHORT_ANSWER'], { feedback, preferences: { autoNextWhenCorrect } })
  model.selectOption(1); model.selectOption(0)
  assert.equal(model.state.answers[0].confirmed, false)
  assert.equal(model.state.shouldRevealAnswer, false)
  assert.equal(model.state.primaryActionText, feedback === 'IMMEDIATE' ? '确认答案' : '下一题')
  assert.equal(model.getOverviewItems(model.state.answers, 0)[0].isDraft, true)
  const next = model.goNext()
  assert.equal(!!next.autoAdvance, feedback === 'IMMEDIATE' && autoNextWhenCorrect)
  if (feedback === 'IMMEDIATE') {
    assert.equal(model.state.currentIndex, 0)
    assert.equal(model.selectOption(2), null, '即时确认后锁定')
    model.goNext()
  }
  model.setBlank(0, 'A'); model.setBlank(1, 'B')
  assert.deepEqual(Object.keys(model.updateTimer(10).data).sort(), ['timerSeconds', 'timerText'])
  assert.equal(model.getViewData().blankInputs[0].value, 'A', '计时刷新保持当前输入')
  const blank = model.goNext()
  assert.equal(!!blank.autoAdvance, feedback === 'IMMEDIATE' && autoNextWhenCorrect)
  if (feedback === 'IMMEDIATE') model.goNext()
  model.setAnswerText('理解初稿')
  assert.equal(model.state.shouldRevealAnswer, false)
  assert(!JSON.stringify(model.getViewData()).includes('reference-secret'))
  model.setAnswerText('理解定稿')
  assert.equal(model.state.answers[2].text, '理解定稿')
  model.goPrev(); model.jumpToQuestion(0)
  const restored = session(['MULTIPLE_CHOICE', 'FILL_BLANK', 'SHORT_ANSWER'], { feedback })
  restored.restore(normalizeSession(serializeSession(model.getPersistedState())))
  const finished = restored.forceSubmit().data
  assert.equal(finished.score, 100)
  assert.equal(finished.resultItems[2].correctText, 'reference-secret')
  restored.jumpToQuestion(2); restored.assessShortAnswer('WRONG'); restored.finish()
  assert.equal(restored.state.score, 100)
  assert.deepEqual(restored.state.wrongQuestionIds, [])
  assert.equal(restored.state.resultFilterCounts.review, 1)
}
const skippedRating = session(['SHORT_ANSWER'], { preferences: { showSelfAssessment: false } })
skippedRating.setAnswerText('我的理解')
const skipped = skippedRating.forceSubmit().data
assert.equal(skipped.resultItems[0].selfAssessment, '')
assert.equal(skipped.resultFilterCounts.review, 0)
assert.deepEqual(skipped.wrongQuestionIds, [])
assert.equal(skipped.preferences.showSelfAssessment, undefined)

const partial = session(['FILL_BLANK', 'FILL_BLANK'], { feedback: 'AFTER_FINISH' })
partial.reset(); partial.setBlank(0, 'A')
partial.updateTimer(10)
assert.equal(partial.getViewData().blankInputs[0].value, 'A', '首题重置后的填空输入参与草稿投影')
partial.setBlank(0, 'A'); partial.goNext(); partial.setBlank(0, ' ')
assert.equal(partial.submit().data.pendingConfirmationCount, 1)
const partialResult = partial.autoSubmit().data
assert.equal(partialResult.wrongCount, 1)
assert.equal(partialResult.unansweredCount, 1)
const wrong = session(['MULTIPLE_CHOICE', 'SINGLE_CHOICE'], { preferences: { autoNextWhenCorrect: true } })
wrong.selectOption(0)
assert.equal(wrong.goNext().autoAdvance, undefined, '漏选停留')
wrong.goNext(); assert.equal(wrong.selectOption(0).autoAdvance, undefined, '末题不自动前进')
const view = session(['SHORT_ANSWER'], { mode: 'view', preferences: { autoOpenAnalysis: false } })
assert.equal(view.getViewData().shouldRevealAnswer, true)
assert.equal(view.getViewData().currentCorrectAnswerText, 'reference-secret')
assert.equal(view.forceSubmit().command.type, 'returnBankDetail')
const timed = session(['SINGLE_CHOICE'], { mode: 'practice', feedback: 'AFTER_FINISH', timeLimitSeconds: 17 })
assert.equal(timed.state.isTimed, true); assert.equal(timed.state.timerSeconds, 17)
assert.equal(session(['SINGLE_CHOICE'], { mode: 'test', feedback: 'IMMEDIATE', isTimed: false }).state.isTimed, false)

const vm = new PracticeViewModel({ storage: { get: () => null, set: () => { throw new Error('存储已满') } } })
vm.session = session(['MULTIPLE_CHOICE', 'SHORT_ANSWER'])
vm.persistSession = () => { throw new Error('存储已满') }
vm.session.selectOption(0)
assert.match(vm.goNext().command.title, /存储/)
assert.equal(vm.session.state.currentIndex, 0)
assert.equal(vm.forceSubmit().data.isCompleted, false)
assert.deepEqual(vm.session.state.answers[0].selectedKeys, ['A'])

const wrongBook = require('../miniprogram/utils/wrong-book.js')
const repository = require('../miniprogram/repositories/practice-repository.js')
const { WrongBookViewModel } = require('../miniprogram/viewmodels/wrong-book-viewmodel.js')
const stored = {}
const storage = { get: key => stored[key], set: (key, value) => { stored[key] = value }, keys: () => Object.keys(stored) }

console.log("answer confirmation and drafts passed")
