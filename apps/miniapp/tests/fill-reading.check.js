const assert = require('node:assert/strict')
const { mapQuestion, OnlinePractice } = require('../miniprogram/repositories/online-practice.js')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const { serializeSession, normalizeSession } = require('../miniprogram/models/practice-session-state.js')
const { gradeBlanks } = require('../miniprogram/utils/fill-blank.js')
const item = { itemId: 'i', question: { id: 'q', type: 'FILL_BLANK', stem: '{{1}} 和 {{2}}', blankCount: 2, material: { id: 'r', revisionId: 'r1', passage: '阅读材料\n第二行', assetIds: [] } } }
const grading = { itemId: 'i', blanks: [{ answers: ['HTTP', '超文本传输协议'] }, { answers: ['GET'] }], blankMatch: { trimWhitespace: true, ignoreCase: true }, explanation: '确认后显示' }
const q = mapQuestion(item, grading)
assert(gradeBlanks(q, [' http ', 'get']))
assert(!gradeBlanks(q, ['http', 'POST']))
assert(!gradeBlanks({ ...q, blankMatch: { trimWhitespace: false, ignoreCase: false } }, [' http ', 'GET']))
for (const mode of ['order', 'test']) {
  const session = new PracticeSession({ quiz: { questions: [q], bankId: 'b' }, mode })
  session.showQuestionAtIndex(0)
  assert.equal(session.getViewData().blankInputs.length, 2)
  assert.equal(session.getViewData().currentQuestion.material.passage, '阅读材料\n第二行')
  assert(!JSON.stringify(session.getViewData()).includes('超文本传输协议'))
  session.setBlank(0, ' http ')
  assert.equal(session.getOverviewItems(session.state.answers, 0)[0].answered, false)
  const saved = normalizeSession(serializeSession(session.getPersistedState()))
  const restored = new PracticeSession({ quiz: { questions: [q], bankId: 'b' }, mode })
  restored.restore(saved)
  assert.equal(restored.getViewData().blankInputs[0].value, ' http ')
  restored.setBlank(1, 'get')
  restored.commitCurrentAnswer([])
  assert.equal(restored.state.answers[0].isCorrect, true)
  assert.equal(restored.getViewData().shouldRevealAnswer, mode === 'order')
  if (mode === 'test') assert(!JSON.stringify(restored.getViewData()).includes('超文本传输协议'))
  const result = restored.finish().data
  assert.equal(result.resultItems[0].isCorrect, true)
  assert(result.resultItems[0].correctText.includes('超文本传输协议'))
}
const snapshot = { id: 's', questionBankId: 'b', route: {}, items: [{ ...item, answer: { blanks: ['HTTP', 'GET'] }, confirmed: true }], offlineGrading: [grading] }
const remote = OnlinePractice.prototype.restored.call({ quiz: value => OnlinePractice.prototype.quiz(value) }, snapshot)
assert.deepEqual(remote.answers[0].blanks, ['HTTP', 'GET'])
assert.equal(remote.answers[0].isCorrect, true)
const { PracticeLayoutViewModel } = require('../miniprogram/viewmodels/practice-layout-viewmodel.js')
const editor = new PracticeLayoutViewModel({ storage: { get: () => null, set: () => assert.fail('通用模板预览不写学习记录或试答额度') } })
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const restart = new PracticeViewModel({ storage: {} })
restart.session = {}; restart.trial = true; restart.routeOptions = { sessionId: 'old', selectionKey: 'old-preview', mode: 'test', bankId: 'b' }
restart.load = options => options
assert.equal(restart.reset().selectionKey, '', '重练重新选题，不使用过期的预览标识')
const preview = editor.load().data
assert.equal(preview.shouldRevealAnswer, true)
assert.equal(preview.hasAnswered, true)
console.log('fill and reading: grading, disclosure, draft restore and formal snapshot passed')
