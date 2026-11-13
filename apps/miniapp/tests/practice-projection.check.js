const assert = require('node:assert/strict')
const { getOverviewItems } = require('../miniprogram/models/practice-presentation.js')
const { quiz } = require('../miniprogram/models/practice-snapshot.js')

for (const count of [20, 100, 1000]) {
  let checks = 0
  const questions = Array.from({ length: count }, (_, index) => ({ id: String(index) }))
  const answers = questions.map((_, index) => index % 3 ? { confirmed: index % 2 === 0, isCorrect: true, selectedKeys: ['A'] } : null)
  const session = { state: { questions, favoriteQuestionIds: questions.map(q => q.id), markedQuestionIds: ['0', 'missing'] }, hasInput: (_, answer) => { checks++; return !!answer } }
  const rows = getOverviewItems(session, answers, 1)
  assert.equal(checks, count)
  assert.equal(rows.length, count)
  assert.equal(rows[0].isMarked, true)
  assert.equal(rows[1].isCurrent, true)
  assert.equal(rows[1].isDraft, true)
  assert.equal(rows[2].answered, true)
  assert(rows.every(row => row.isFavorite))
  const items = questions.map(q => ({ itemId: q.id, question: { ...q, type: 'SINGLE_CHOICE', options: [] } }))
  const grading = items.map(item => ({ itemId: item.itemId, correctAnswer: ['A'] }))
  grading.push({ itemId: '0', correctAnswer: ['B'] })
  const result = quiz({ items, offlineGrading: grading, route: {} })
  assert.deepEqual(result.questions.map(q => q.id), questions.map(q => q.id))
  assert(result.questions.every(q => q.answerKeys[0] === 'A'))
}
console.log('practice projections: linear input checks, membership, order and grading match passed')
