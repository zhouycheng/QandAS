function snapshots(storage) {
  if (!storage) return []
  const auth = storage.get('qandaAuth') || {}, user = auth.userId
  if (!user) return []
  const entries = storage.get(`qandaPracticeRecords:${user}`) || {}
  const ids = new Set(Object.keys(entries).concat(storage.get(`qandaSync:v1:${user}:index`) || []))
  const runtime = require('./online-practice.js').current()
  return Array.from(ids).map(id => runtime && runtime.userId === user ? runtime.get(id) : require('./answer-vault.js').restore(storage.get(`qandaOnline:${user}:${id}`))).filter(s => s && s.localResult).sort((a, b) => Date.parse(a.localResult.submittedAt) - Date.parse(b.localResult.submittedAt))
}
function pending(snapshots, overview) {
  const included = new Set(overview && overview.includedSessionIds || [])
  return snapshots.filter(s => !included.has(s.id))
}
function facts(overview, records) {
  const result = new Map((overview.questionFacts || []).map(q => [q.questionId, { ...q }]))
  for (const snapshot of pending(records, overview)) for (const item of snapshot.localResult.items) {
    if (!item.outcome || item.outcome === 'UNANSWERED') continue
    const id = item.question.id, old = result.get(id) || { questionId: id, rightCount: 0, wrongCount: 0, judgment: '' }
    const next = { ...old, rightCount: old.rightCount + (item.outcome === 'CORRECT' ? 1 : 0), wrongCount: old.wrongCount + (item.outcome === 'WRONG' && (old.wrongCount || snapshot.autoAddWrongBook !== false) ? 1 : 0) }
    if (!old.lastPracticedAt || Date.parse(old.lastPracticedAt) <= Date.parse(snapshot.localResult.submittedAt)) Object.assign(next, { judgment: item.outcome, selfAssessment: item.selfAssessment || old.selfAssessment, lastPracticedAt: snapshot.localResult.submittedAt, item, snapshot })
    result.set(id, next)
  }
  for (const snapshot of records) for (const itemId of Object.keys(snapshot.assessmentCommands || {})) {
    const item = snapshot.localResult.items.find(i => i.itemId === itemId), old = item && result.get(item.question.id)
    if (old && old.judgment === 'SELF_RATED' && Date.parse(old.lastPracticedAt) <= Date.parse(snapshot.localResult.submittedAt)) result.set(item.question.id, { ...old, selfAssessment: item.selfAssessment, item, snapshot })
  }
  return result
}
function assessmentDelta(value, base, records) {
  const included = new Set(base && base.includedSessionIds || [])
  const stored = new Map((base && base.assessmentFacts || []).map(item => [item.itemId, item.selfAssessment]))
  for (const snapshot of records.filter(s => included.has(s.id))) for (const [itemId, command] of Object.entries(snapshot.assessmentCommands || {})) {
    const item = snapshot.localResult.items.find(i => i.itemId === itemId)
    if (!item) continue
    const before = stored.has(itemId) ? stored.get(itemId) : command.baseAssessment, after = item.selfAssessment
    for (const [field, test] of [['selfRatedCount', v => !!v], ['selfRatedCorrectCount', v => v === 'CORRECT'], ['selfRatedWrongCount', v => v === 'WRONG']]) value[field] = (value[field] || 0) + Number(test(after)) - Number(test(before))
  }
}
function overview(base, records) {
  const value = { ...(base || {}) }
  const unconfirmed = pending(records, base)
  for (const snapshot of unconfirmed) {
    const r = snapshot.localResult
    for (const [field, n] of Object.entries({ answerAttemptCount: r.answeredCount, objectiveAnsweredCount: r.objective.answered, objectiveCorrectCount: r.objective.correct, durationSeconds: r.durationSeconds, practiceCount: 1, selfRatedCount: r.shortAnswer.rated, selfRatedCorrectCount: r.shortAnswer.correct, selfRatedWrongCount: r.shortAnswer.wrong })) value[field] = (value[field] || 0) + n
  }
  assessmentDelta(value, base, records)
  const before = facts(base || {}, []), after = facts(base || {}, records)
  const count = (all, test) => Array.from(all.values()).filter(test).length
  for (const [field, test] of Object.entries({ answeredCount: q => !!q.judgment, distinctQuestionCount: q => !!q.judgment, correctCount: q => q.judgment === 'CORRECT', wrongCount: q => q.judgment === 'WRONG', wrongBookCount: q => q.wrongCount > 0 && q.judgment === 'WRONG', masteredCount: q => q.wrongCount > 0 && q.judgment === 'CORRECT' })) value[field] = (value[field] || 0) + count(after, test) - count(before, test)
  value.objectiveAccuracy = value.objectiveAnsweredCount ? value.objectiveCorrectCount / value.objectiveAnsweredCount : null
  return value
}
function wrong(base, records) {
  return Array.from(facts(base || {}, records).values()).filter(q => q.item && q.wrongCount > 0).map(q => {
    const question = q.item.question
    return { questionId: question.id, questionBankId: question.questionBankId || q.snapshot.questionBankId, stem: question.stem, type: question.type,
      contentFormat: question.contentFormat, presentation: question.presentation, lastOutcome: q.judgment, lastPracticedAt: q.lastPracticedAt, rightCount: q.rightCount, wrongCount: q.wrongCount,
      subjectId: q.snapshot.route && q.snapshot.route.subjectId, questionBankName: q.snapshot.title, available: true }
  })
}
module.exports = { snapshots, pending, overview, facts, wrong }

const day = stamp => new Date(Date.parse(stamp) + 8 * 3600000).toISOString().slice(0, 10)
function statistics(base, records) {
  if (!base) return base
  const result = { ...base }, known = new Set(base.knownQuestionIds || [])
  for (const snapshot of pending(records, base)) {
    const r = snapshot.localResult, date = day(r.submittedAt)
    if (date < base.startDate || date >= base.endDateExclusive) continue
    for (const [field, n] of Object.entries({ practiceCount: 1, totalCount: r.totalCount, answeredCount: r.answeredCount, answerAttemptCount: r.answeredCount, correctCount: r.objective.correct, objectiveCorrectCount: r.objective.correct, wrongCount: r.objective.wrong, unansweredCount: r.totalCount - r.answeredCount, objectiveAnsweredCount: r.objective.answered, shortAnswerCount: r.shortAnswer.count, selfRatedCount: r.shortAnswer.rated, selfRatedCorrectCount: r.shortAnswer.correct, selfRatedWrongCount: r.shortAnswer.wrong, durationSeconds: r.durationSeconds })) result[field] = (result[field] || 0) + n
    for (const item of r.items) if (item.outcome && item.outcome !== 'UNANSWERED' && !known.has(item.question.id)) { known.add(item.question.id); result.distinctQuestionCount = (result.distinctQuestionCount || 0) + 1 }
  }
  assessmentDelta(result, base, records)
  result.objectiveAccuracy = result.objectiveAnsweredCount ? result.objectiveCorrectCount / result.objectiveAnsweredCount : null
  return result
}
function days(base, records) {
  const result = new Map((base || []).map(row => [row.date, { ...row }]))
  for (const snapshot of records) {
    const r = snapshot.localResult, date = day(r.submittedAt), row = result.get(date) || { date, practiceCount: 0, answeredCount: 0, correctCount: 0, durationSeconds: 0, objectiveAnsweredCount: 0 }
    if (!(row.includedSessionIds || []).includes(snapshot.id)) {
      row.practiceCount++; row.answeredCount += r.answeredCount; row.correctCount += r.objective.correct; row.durationSeconds += r.durationSeconds; row.objectiveAnsweredCount += r.objective.answered
    }
    result.set(date, row)
  }
  return Array.from(result.values())
}
module.exports.statistics = statistics
module.exports.days = days

function collectionRows(base, records, withPending) {
  const metadata = new Map()
  for (const snapshot of records) for (const item of snapshot.localResult.items) metadata.set(item.question.id, { item, snapshot })
  return Array.from(facts(base || {}, withPending ? records : []).values()).map(q => {
    const source = q.item ? q : metadata.get(q.questionId)
    if (!source) return null
    const item = source.item, snapshot = source.snapshot, question = item.question
    return { questionId: question.id, questionBankId: question.questionBankId || snapshot.questionBankId, subjectId: snapshot.route && snapshot.route.subjectId || question.subjectId,
      questionBankName: snapshot.title || '', subjectName: question.subjectName || '', stem: question.stem, type: question.type, contentFormat: question.contentFormat,
      lastOutcome: q.judgment, lastPracticedAt: q.lastPracticedAt, selfAssessment: q.selfAssessment === undefined ? item.selfAssessment : q.selfAssessment, rightCount: q.rightCount, wrongCount: q.wrongCount,
      available: !(snapshot.revisionUpdates || []).some(row => row.questionId === question.id && !row.available) }
  }).filter(Boolean)
}
function matchesCollection(row, options) {
  if (options.subjectId && row.subjectId !== options.subjectId || options.questionBankId && row.questionBankId !== options.questionBankId) return false
  if (options.chip === 'subjective') return row.lastOutcome === 'SELF_RATED' && row.selfAssessment === 'WRONG'
  if (row.lastOutcome !== 'WRONG' || !row.wrongCount) return false
  if (options.chip === 'repeat' && row.wrongCount < 2 || options.chip === 'recent' && Date.parse(row.lastPracticedAt) < Date.now() - 7 * 86400000) return false
  return true
}
module.exports.collectionRows = collectionRows
module.exports.matchesCollection = matchesCollection
