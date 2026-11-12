function progress(session, snapshot) {
  const state = session.state
  return snapshot.items.map((item, i) => {
    const answer = state.answers[i], question = state.questions[i]
    const editing = i === state.currentIndex && (!answer || answer.confirmed === false)
    const keys = editing ? state.selectedKeys : answer && answer.selectedKeys || []
    const raw = question.isFillBlank ? (answer && answer.blanks && answer.blanks.some(v => v.trim()) ? { blanks: answer.blanks.slice() } : null)
      : question.isShortAnswer ? (answer && answer.text && answer.text.trim() ? { text: answer.text } : null)
        : keys.length ? (question.type === 'TRUE_FALSE' ? { value: keys[0] === 'true' } : { optionKeys: keys.slice() }) : null
    const confirmed = !!answer && answer.confirmed !== false && !!raw
    return { itemId: item.itemId, revisionId: item.question.revisionId, materialRevisionId: item.question.material && item.question.material.revisionId || null,
      answer: raw, confirmed, marked: (state.markedQuestionIds || state.markedIds || []).includes(item.question.id), outcome: confirmed ? question.isShortAnswer ? 'SELF_RATED' : answer.isCorrect ? 'CORRECT' : 'WRONG' : state.isCompleted ? 'UNANSWERED' : null,
      selfAssessment: confirmed && question.isShortAnswer ? answer.selfAssessment || null : null }
  })
}
function summary(items, changes) {
  const objectiveItems = items.filter(i => i.question.type !== 'SHORT_ANSWER'), byId = new Map(changes.map(i => [i.itemId, i]))
  const correct = objectiveItems.filter(i => byId.get(i.itemId).outcome === 'CORRECT').length
  const wrong = objectiveItems.filter(i => byId.get(i.itemId).outcome === 'WRONG').length
  const short = items.filter(i => i.question.type === 'SHORT_ANSWER').map(i => byId.get(i.itemId))
  const rated = short.filter(i => i.selfAssessment).length
  return { totalCount: items.length, answeredCount: changes.filter(i => i.outcome && i.outcome !== 'UNANSWERED').length,
    objective: { count: objectiveItems.length, answered: correct + wrong, correct, wrong, unanswered: objectiveItems.length - correct - wrong, accuracy: correct + wrong ? correct / (correct + wrong) : null, score: objectiveItems.length ? Math.round(correct * 100 / objectiveItems.length) : null },
    shortAnswer: { count: short.length, answered: short.filter(i => i.outcome === 'SELF_RATED').length, rated, correct: short.filter(i => i.selfAssessment === 'CORRECT').length, wrong: short.filter(i => i.selfAssessment === 'WRONG').length, unrated: short.length - rated } }
}
function result(session, snapshot) {
  const changes = progress(session, snapshot)
  return { ...summary(snapshot.items, changes), id: snapshot.id, sessionId: snapshot.id, version: snapshot.version, durationSeconds: session.getPersistedState().elapsedTime,
    submittedAt: new Date().toISOString(), resultSource: 'CLIENT',
    items: snapshot.items.map((item, i) => ({ ...item, ...changes[i] })) }
}
module.exports = { progress, summary, result }
