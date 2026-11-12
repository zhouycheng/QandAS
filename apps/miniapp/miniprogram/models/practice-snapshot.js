const { gradeBlanks } = require('../utils/fill-blank.js')
function mapQuestion(item, grading) {
  const q = item.question
  const g = grading || q
  const boolean = q.type === 'TRUE_FALSE'
  return {
    id: q.id, itemId: item.itemId, revisionId: q.revisionId, type: q.type,
    typeText: { CONCEPT: '概述题', CODE_ANALYSIS: '代码分析', CODE_WRITING: '代码编写' }[q.presentation] || { SINGLE_CHOICE: '单选题', MULTIPLE_CHOICE: '多选题', TRUE_FALSE: '判断题', FILL_BLANK: '填空题', SHORT_ANSWER: '简答题' }[q.type],
    contentFormat: q.contentFormat || 'PLAIN_TEXT', presentation: q.presentation || 'STANDARD', codeLanguage: q.codeLanguage || 'text', stem: q.stem, isMultiple: q.type === 'MULTIPLE_CHOICE', isShortAnswer: q.type === 'SHORT_ANSWER',
    isFillBlank: q.type === 'FILL_BLANK', blankCount: q.blankCount || 0, blanks: g.blanks || Array.from({ length: q.blankCount || 0 }, () => ({ answers: [] })), blankMatch: g.blankMatch || {},
    scoringPoints: g.scoringPoints || [], material: q.material || null, imagePaths: q.imagePaths || [],
    options: boolean ? [{ key: 'true', label: 'A', text: '正确' }, { key: 'false', label: 'B', text: '错误' }] : (q.options || []).map(o => ({ key: o.key, label: o.key, text: o.content })),
    answerKeys: boolean ? (typeof g.correctValue === 'boolean' ? [String(g.correctValue)] : []) : (g.correctAnswer || []),
    referenceAnswer: g.referenceAnswer || '', explanation: g.explanation || '', assetIds: q.assetIds || []
  }
}
function quiz(snapshot) {
    return { subjectId: snapshot.route.subjectId || '', bankId: snapshot.questionBankId, title: snapshot.title || '题库练习', storageKey: '', questions: ((snapshot.localResult && snapshot.localResult.items) || (snapshot.result && snapshot.result.items) || snapshot.items).map(item => mapQuestion(item, (snapshot.offlineGrading || []).find(g => g.itemId === item.itemId))) }
  }
function restored(snapshot) {
    if (snapshot.localState && (!snapshot.result || snapshot.localResult)) return JSON.parse(JSON.stringify(snapshot.localState))
    const questions = quiz(snapshot).questions
    const items = (snapshot.localResult && snapshot.localResult.items) || (snapshot.result && snapshot.result.items) || snapshot.items
    return { sessionId: snapshot.id, questionIds: questions.map(q => q.id), questionOrder: questions.map((_, i) => i), currentIndex: snapshot.localState && snapshot.localState.currentIndex || snapshot.currentIndex || 0, elapsedTime: snapshot.result ? snapshot.result.durationSeconds : snapshot.durationSeconds,
      markedIds: items.filter(i => i.marked).map(i => i.question.id),
      answers: items.map((item, index) => item.answer ? { questionId: item.question.id, selectedKeys: item.answer.optionKeys || (item.answer.value === null || item.answer.value === undefined ? [] : [String(item.answer.value)]), text: item.answer.text || '', blanks: item.answer.blanks || [], confirmed: item.confirmed, selfAssessment: item.selfAssessment, isCorrect: item.question.type === 'SHORT_ANSWER' ? false : item.outcome ? item.outcome === 'CORRECT' : item.question.type === 'FILL_BLANK' ? gradeBlanks(questions[index], item.answer.blanks) : JSON.stringify((item.answer.optionKeys || (item.answer.value === undefined || item.answer.value === null ? [] : [String(item.answer.value)])).slice().sort()) === JSON.stringify(questions[index].answerKeys.slice().sort()) } : null),
      status: (snapshot.localResult || snapshot.result || snapshot.status === 'SUBMITTED') ? 'SUBMITTED' : 'IN_PROGRESS', config: snapshot.route }
  }
module.exports = { mapQuestion, quiz, restored }
