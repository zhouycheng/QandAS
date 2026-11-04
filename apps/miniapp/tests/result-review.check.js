const assert = require('node:assert/strict')
const { PracticeSession, filterResultItems } = require('../miniprogram/models/practice-session.js')
const { viewPatch } = require('../miniprogram/models/view-patch.js')

function session(count = 3, preferences = {}) {
  const questions = Array.from({ length: count }, (_, index) => ({ id: 'q' + index, stem: '题目 ' + index, type: 'SINGLE_CHOICE',
    typeText: '单选题', options: [{ key: 'A', label: 'A', text: '甲' }, { key: 'B', label: 'B', text: '乙' }], answerKeys: ['A'], explanation: '解析' }))
  const value = new PracticeSession({ quiz: { subjectId: 's', bankId: 'b', title: '练习', questions }, mode: 'order', preferences })
  value.reset()
  return value
}
const practice = session()
practice.selectOption(0); practice.goNext(); practice.selectOption(1)
const result = practice.forceSubmit().data
assert.equal(result.correctCount, 1)
assert.equal(result.wrongCount, 1)
assert.equal(result.unansweredCount, 1)
assert.equal(result.score, 33)
assert.equal(filterResultItems(result.resultItems, 'wrong').length, 1)
assert.equal(filterResultItems(result.resultItems, 'unanswered').length, 1)
assert.equal(filterResultItems(result.resultItems, 'all', '题目 1')[0].id, 'q1')
assert.equal(practice.finish().data.score, result.score, '重复交卷保持相同成绩')
const restored = session()
restored.restore(practice.getPersistedState())
assert.equal(restored.state.currentIndex, practice.state.currentIndex)
assert.deepEqual(restored.state.answers, practice.state.answers)
const hidden = session(1, { autoShowExplanation: false })
hidden.selectOption(0)
assert.equal(hidden.state.shouldRevealAnswer, true)
assert.equal(hidden.state.shouldShowExplanation, false)
const measurements = []
for (const count of [20, 100, 1000]) {
  const value = session(count)
  const before = value.getViewData()
  const next = value.selectOption(0).data
  const patch = viewPatch(before, next)
  assert.equal(patch.questions, undefined)
  assert.equal(patch.overviewItems, undefined)
  assert(Buffer.byteLength(JSON.stringify(patch)) < 6000)
  const updated = structuredClone(before)
  Object.entries(patch).forEach(([key, item]) => {
    const indexed = /^(\w+)\[(\d+)\]$/.exec(key)
    if (indexed) updated[indexed[1]][Number(indexed[2])] = item
    else updated[key] = item
  })
  assert.deepEqual(updated, next)
  measurements.push({ count, fullBytes: Buffer.byteLength(JSON.stringify(next)), patchBytes: Buffer.byteLength(JSON.stringify(patch)) })
}
assert.deepEqual(viewPatch({ value: 1 }, { value: 1 }), {})
const overview = session()
overview.selectOption(0)
let overviewProjections = 0
const projectOverview = overview.getOverviewItems.bind(overview)
overview.getOverviewItems = (...args) => { overviewProjections += 1; return projectOverview(...args) }
const card = overview.openQuestionOverview().data
assert.equal(overviewProjections, 1, '打开答题卡复用同一份条目计算待确认数')
assert.equal(card.overviewItems[0].answered, true)
assert.equal(card.overviewItems[0].isCorrect, false, '交卷前答题卡不投影对错')
assert.equal(card.overviewItems[1].answered, false)
assert.equal(card.pendingConfirmationCount, 0)
console.log('result rules and sparse view updates passed', JSON.stringify(measurements))
