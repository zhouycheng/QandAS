const { blankAnswerText } = require('../utils/fill-blank.js')
const { SESSION_STATUS } = require('./practice-session-state.js')
const RESULT_FILTERS = {
  ALL: 'all',
  CORRECT: 'correct',
  WRONG: 'wrong',
  UNANSWERED: 'unanswered',
  REVIEW: 'review',
  UNSCORED: 'unscored'
}
const RESULT_FILTER_TEXT = {
  all: '全部',
  correct: '正确',
  wrong: '错误',
  unanswered: '未答',
  review: '待复习',
  unscored: '不计分'
}
function filterResultItems(items, filter, keyword) {
  const source = Array.isArray(items) ? items : []
  const normalizedFilter = RESULT_FILTER_TEXT[filter] ? filter : RESULT_FILTERS.ALL
  const needle = String(keyword === undefined || keyword === null ? '' : keyword).trim().toLowerCase()

  return source.filter((item) => {
    if (!item) {
      return false
    }

    if (normalizedFilter === RESULT_FILTERS.CORRECT && !(item.answered && !item.isShortAnswer && item.isCorrect)) {
      return false
    }

    if (normalizedFilter === RESULT_FILTERS.WRONG && !(item.answered && !item.isShortAnswer && !item.isCorrect)) {
      return false
    }

    if (normalizedFilter === RESULT_FILTERS.UNANSWERED && item.answered) {
      return false
    }

    if (normalizedFilter === RESULT_FILTERS.REVIEW && item.selfAssessment !== 'WRONG') return false
    if (normalizedFilter === RESULT_FILTERS.UNSCORED && !item.isShortAnswer) return false

    if (!needle) {
      return true
    }

    const haystack = [
      item.stem,
      item.searchText,
      item.selectedText,
      item.correctText,
      item.explanation
    ].filter(Boolean).join(' ').toLowerCase()

    return haystack.indexOf(needle) >= 0
  })
}
function countResultItems(items) {
  const source = Array.isArray(items) ? items : []
  const answeredItems = source.filter((item) => item && item.answered)

  return {
    all: source.length,
    review: source.filter(item => item.selfAssessment === 'WRONG').length,
    unscored: source.filter(item => item.isShortAnswer).length,
    correct: answeredItems.filter((item) => !item.isShortAnswer && item.isCorrect).length,
    wrong: answeredItems.filter((item) => item.answered && !item.isShortAnswer && !item.isCorrect).length,
    unanswered: source.filter((item) => item && !item.answered).length
  }
}
function finish(session) {
    if (session.state.isViewMode) return session.returnCommand()
    const questions = session.state.questions

    if (!questions.length) {
      return null
    }

    // 交卷只能落盘一次：重复调用（例如交卷弹窗与超时自动交卷同时触发）
    // 会把同一份结果重复累加进错题本与进度表。
    const alreadyCompleted = session.state.isCompleted
    if (!alreadyCompleted) session.confirmAllAnswers()
    const answers = session.state.answers
    const objectiveCount = questions.filter(question => !question.isShortAnswer).length
    const objectiveAnswered = questions.filter((question, index) => !question.isShortAnswer && session.hasInput(question, answers[index])).length
    const correctCount = answers.filter((item, index) => !questions[index].isShortAnswer && item && item.isCorrect).length
    const score = objectiveCount ? Math.round((correctCount / objectiveCount) * 100) : null
    const bestScore = score === null ? session.state.bestScore : Math.max(score, session.state.bestScore)
    const resultItems = questions.map((question, index) => {
      // 先取原始值再兜底：直接写 answers[index] || {} 会让未作答也变成 truthy，
      // 于是"没做"被误判成"已答"（且计为答错）
      const rawAnswer = answers[index]
      const answer = rawAnswer || {}
      // answered 必须显式区分：未作答的 isCorrect 也是 false，
      // 只靠 isCorrect 筛选会把"没做"和"做错"混成一类
      const answered = !!rawAnswer && rawAnswer.confirmed !== false

      return {
        id: question.id,
        number: index + 1,
        typeText: question.typeText,
        isShortAnswer: !!question.isShortAnswer,
        blankInputs: question.isFillBlank ? (question.blanks || []).map((_, i) => ({ value: (answer.blanks || [])[i] || '' })) : null,
        contentFormat: question.contentFormat || 'PLAIN_TEXT',
        presentation: question.presentation || 'STANDARD',
        codeLanguage: question.codeLanguage || 'text',
        selfAssessment: answer.selfAssessment || '',
        stem: question.stem,
        material: question.material || null,
        assetIds: question.assetIds || [],
        imagePaths: question.imagePaths || [],
        scoringPoints: question.scoringPoints || [],
        selectedText: question.isFillBlank ? (answer.blanks || []).map((value, i) => `${String.fromCharCode(9312 + i)} ${value || '未填写'}`).join('\n') || '未作答' : answer.text || session.getAnswerText(question, answer.selectedKeys) || '未作答',
        correctText: question.isFillBlank ? blankAnswerText(question) : question.isShortAnswer ? question.referenceAnswer : session.getAnswerText(question, question.answerKeys),
        answered,
        isCorrect: answered && !question.isShortAnswer && !!answer.isCorrect,
        explanation: session.getExplanation(question),
        // 搜索用：题干 + 全部选项文本预先拼好，避免在 WXML 里做字符串运算
        searchText: `${question.stem} ${(question.options || []).map((option) => option.text).join(' ')}`,
        options: (question.options || []).map((option) => ({
          key: option.key,
          label: option.label,
          text: option.text,
          isCorrectOption: question.answerKeys.indexOf(option.key) >= 0,
          isSelected: (answer.selectedKeys || []).indexOf(option.key) >= 0
        }))
      }
    })

    const wrongQuestionIds = resultItems
      .filter((item) => item.answered && !item.isShortAnswer && !item.isCorrect)
      .map((item) => item.id)
    const answeredCount = resultItems.filter(item => item.answered).length

    return session.updateState({
      answers: answers.slice(),
      isCompleted: true,
      // 交卷即进入 SUBMITTED；同步状态由 ViewModel 决定（成功 SYNCED / 失败 SYNC_PENDING）
      sessionStatus: SESSION_STATUS.SUBMITTED,
      showSubmitModal: false,
      showQuestionOverview: false,
      correctCount,
      objectiveCount,
      unansweredCount: questions.length - answeredCount,
      pendingConfirmationCount: 0,
      objectiveAccuracyText: objectiveAnswered ? `${Math.round(correctCount / objectiveAnswered * 1000) / 10}%` : '—',
      scoreText: score === null ? '已完成' : `${score} 分`,
      score,
      bestScore,
      wrongQuestionIds,
      wrongCount: wrongQuestionIds.length,
      hasWrongQuestions: wrongQuestionIds.length > 0,
      resultItems,
      // 结果页答题卡直接复用 overviewItems：不重新算一遍，
      // 但必须在这里按最终 answers 重刷一次——交卷前它只反映"打开弹层那一刻"的快照，
      // 交卷后若沿用旧值，结果页会整片灰格（answered 全 false）。
      // currentIndex 传 -1：已交卷没有"当前题"，不该有格子高亮。
      overviewItems: session.getOverviewItems(answers, -1),
      // 交卷后复盘区从"全部"开始，不清空上一轮的搜索词
      resultFilter: RESULT_FILTERS.ALL,
      filteredResultItems: resultItems,
      resultFilterCounts: countResultItems(resultItems),
      resultFilterEmptyText: resultItems.length ? '暂无题目' : '暂无题目'
    }, {
      stopTimer: true
    })
  }
module.exports = { finish, filterResultItems, countResultItems, RESULT_FILTERS, RESULT_FILTER_TEXT }
