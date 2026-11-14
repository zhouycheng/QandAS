const { DEFAULT_PRACTICE_TITLE, DEFAULT_TEST_DURATION_MINUTES, PRACTICE_MODES, formatTimer, getInitialPracticeViewData } = require('./practice-view-data.js')
const { projectPractice, readingProgress, getQuestionView, getOverviewItems, getAnswerText, getCorrectAnswerText, getExplanation } = require('./practice-presentation.js')
const { finish, filterResultItems, countResultItems, buildResultReviewPatch, RESULT_FILTERS, RESULT_FILTER_TEXT } = require('./practice-results.js')
const { normalizePreferences, normalizePracticeOptions } = require('../utils/preferences.js')
const { ranks } = require('../utils/practice-layout.js')
const { gradeBlanks } = require('../utils/fill-blank.js')
const {
  SESSION_STATUS,
  SYNC_STATUS,
  createSessionId,
  deriveQuestionStates
} = require('./practice-session-state.js')

// 导航副标题与练习模式共用同一套名称。
const MODE_LABELS = {
  order: '顺序练习',
  practice: '练习模式',
  view: '背题模式',
  test: '模拟测试'
}

function normalizeMode(value) {
  if (
    value === PRACTICE_MODES.VIEW ||
    value === PRACTICE_MODES.TEST ||
    value === PRACTICE_MODES.ORDER
  ) {
    return value
  }

  return PRACTICE_MODES.PRACTICE
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

class PracticeSession {
  constructor(options) {
    const normalizedOptions = options || {}
    const quiz = normalizedOptions.quiz || null
    const mode = normalizeMode(normalizedOptions.mode)
    const isViewMode = mode === PRACTICE_MODES.VIEW
    const isTestMode = mode === PRACTICE_MODES.TEST
    const durationMinutes = parsePositiveInteger(normalizedOptions.durationMinutes, DEFAULT_TEST_DURATION_MINUTES)
    const durationSeconds = parsePositiveInteger(normalizedOptions.timeLimitSeconds, durationMinutes * 60)
    const preferences = Object.assign(normalizePreferences(normalizedOptions.preferences), normalizePracticeOptions(normalizedOptions.config, normalizedOptions.preferences))
    const restored = normalizedOptions.restored || null
    const now = typeof normalizedOptions.now === 'number' ? normalizedOptions.now : Date.now()

    this.storageKey = normalizedOptions.storageKey || ''
    this.preferences = preferences
    // 持久态与视图态分开：questionIds / questionOrder 这类字段页面不需要，
    // 不该跟着每次 setData 一起下发
    this.meta = {
      sessionId: (restored && restored.sessionId) || createSessionId(now, normalizedOptions.random),
      subjectId: quiz ? quiz.subjectId : '',
      questionBankId: quiz ? quiz.bankId : '',
      config: Object.assign({}, normalizedOptions.config, normalizePracticeOptions(preferences), { feedback: normalizedOptions.feedback || (isTestMode ? 'AFTER_FINISH' : 'IMMEDIATE') }),
      questionIds: (restored && restored.questionIds) || null,
      questionOrder: (restored && restored.questionOrder) || null,
      createdAt: (restored && restored.createdAt) || now,
      updatedAt: now
    }
    this.state = Object.assign(getInitialPracticeViewData(), {
      mode,
      isViewMode,
      isTestMode,
      isTimed: !isViewMode && (normalizedOptions.isTimed === undefined ? isTestMode || !!normalizedOptions.timeLimitSeconds : normalizedOptions.isTimed),
      feedback: normalizedOptions.feedback || (isTestMode ? 'AFTER_FINISH' : 'IMMEDIATE'),
      sessionId: this.meta.sessionId,
      sessionStatus: (restored && restored.status) || SESSION_STATUS.IN_PROGRESS,
      syncStatus: (restored && restored.syncStatus) || SYNC_STATUS.LOCAL_ONLY,
      // 背题模式直接给答案与解析，不受偏好影响
      shouldRevealAnswer: isViewMode,
      preferences,
      layoutRanks: ranks(preferences.moduleOrder),
      subjectId: quiz ? quiz.subjectId : '',
      bankId: quiz ? quiz.bankId : '',
      practiceTitle: quiz ? quiz.title : DEFAULT_PRACTICE_TITLE,
      practiceModeText: MODE_LABELS[mode] || '练习',
      practicePath: normalizedOptions.practicePath || (quiz && quiz.sharePath) || '/page/practice/index',
      questions: quiz ? quiz.questions : [],
      total: quiz ? quiz.questions.length : 0,
      durationSeconds,
      timerSeconds: durationSeconds,
      timerText: formatTimer(durationSeconds),
      bestScore: Number(normalizedOptions.bestScore) || 0,
      favoriteQuestionIds: Array.isArray(normalizedOptions.favoriteQuestionIds)
        ? normalizedOptions.favoriteQuestionIds.slice()
        : [],
      // 标记随会话恢复：中途退出再回来，橙色记号还在
      markedQuestionIds: restored && Array.isArray(restored.markedIds)
        ? restored.markedIds.filter((id) => typeof id === 'string' && id)
        : []
    })
    this.resetStudyClock()
  }

  /**
   * 学习时长时钟：记录本次练习的实际在场时长。
   * 页面切到后台时 pauseStudy 暂停、回到前台 resumeStudy 继续，避免挂机把时长算虚；
   * 交卷时由 finish() 结算并交给 ViewModel 落盘。
   */
  resetStudyClock() {
    this.startedAt = Date.now()
    this.pausedAt = 0
    this.accumulatedMs = 0
  }

  /**
   * 生成「题目集合 + 出题顺序」索引。
   *
   * questionIds 按 id 排序（与出题顺序无关，因此题库小幅增删也不会错位），
   * questionOrder 是它的下标排列，二者组合即可完整还原展示顺序：
   *   questionOrder.map((i) => questionIds[i])
   * 这样存储里只需要放 id 字符串，不用把 234 道题整个写进 storage。
   */
  buildQuestionIndex() {
    if (this.meta.questionIds && this.meta.questionOrder) {
      return this.meta
    }

    const displayIds = this.state.questions.map((question) => question.id)
    const questionIds = displayIds.slice().sort()
    const position = {}

    questionIds.forEach((id, index) => {
      position[id] = index
    })

    this.meta.questionIds = questionIds
    this.meta.questionOrder = displayIds.map((id) => position[id])

    return this.meta
  }

  /** 交给仓储落盘的结构。questionStates 由 answers 派生，避免两处维护 */
  getPersistedState() {
    this.buildQuestionIndex()

    return {
      sessionId: this.meta.sessionId,
      subjectId: this.meta.subjectId,
      questionBankId: this.meta.questionBankId,
      config: this.meta.config,
      questionIds: this.meta.questionIds,
      questionOrder: this.meta.questionOrder,
      currentIndex: this.state.currentIndex,
      answers: this.state.answers,
      questionStates: deriveQuestionStates(this.state.answers, this.state.questions.length),
      // 「标记」只存题号 id：和收藏一样是轻量标记，不存题目本体
      markedIds: this.state.markedQuestionIds.slice(),
      elapsedTime: this.getElapsedSeconds(),
      status: this.state.sessionStatus,
      syncStatus: this.state.syncStatus,
      createdAt: this.meta.createdAt,
      updatedAt: Date.now()
    }
  }

  /**
   * 从落盘数据恢复：答案、当前位置、答题状态、计时。
   *
   * 题库若被改过（题目增删），saved.answers 长度与当前卷不一致，
   * 这里按当前卷长度截断，多出来的丢弃——宁可少恢复一题，也不能下标错位。
   */
  restore(saved) {
    const total = this.state.questions.length

    if (!saved || !total) {
      return null
    }

    const answers = (saved.answers || []).slice(0, total)

    while (answers.length < total) {
      answers.push(null)
    }

    const currentIndex = Math.min(Math.max(Number(saved.currentIndex) || 0, 0), total - 1)

    this.state.answers = answers
    this.state.unansweredCount = this.getUnansweredIndexes(answers).length

    // 标记跟着会话回来：只认本卷里确实存在的题 id，
    // 题库改过之后残留的旧 id 会在答题卡里变成一个点不到的格子
    const markedIds = Array.isArray(saved.markedIds) ? saved.markedIds : []
    this.state.markedQuestionIds = markedIds.filter((id) =>
      this.state.questions.some((question) => question.id === id)
    )
    this.state.markedCount = this.state.markedQuestionIds.length

    // 计时接着算：已累计时间直接写进时钟，本轮在场时间从现在开始叠加
    const elapsedSeconds = Math.max(Number(saved.elapsedTime) || 0, 0)
    this.accumulatedMs = elapsedSeconds * 1000
    this.startedAt = Date.now()
    this.pausedAt = 0

    // 模拟测试的倒计时也要接着走，否则恢复一场 10 分钟的测试会白得一个满时间
    if (this.state.isTimed) {
      this.state.timerSeconds = Math.max(this.state.durationSeconds - elapsedSeconds, 0)
      this.state.timerText = formatTimer(this.state.timerSeconds)
    }

    return this.showQuestionAtIndex(currentIndex)
  }

  /** 结果筛选。只切分类，不动关键词 */
  setResultFilter(filter) {
    const normalizedFilter = RESULT_FILTER_TEXT[filter] ? filter : RESULT_FILTERS.ALL

    return this.updateState(this.buildResultReviewPatch({
      resultFilter: normalizedFilter
    }))
  }

  /** 结果搜索：题干 + 选项 + 你的答案 + 正确答案 一起匹配 */
  setResultKeyword(keyword) {
    return this.updateState(this.buildResultReviewPatch({
      resultKeyword: String(keyword === undefined || keyword === null ? '' : keyword)
    }))
  }
  buildResultReviewPatch(patch) { return buildResultReviewPatch(this, patch) }

  updateSyncStatus(status) {
    return this.updateState({
      syncStatus: status
    })
  }

  pauseStudy() {
    if (this.pausedAt) {
      return null
    }

    this.accumulatedMs += Date.now() - this.startedAt
    this.pausedAt = Date.now()

    return null
  }

  resumeStudy() {
    if (!this.pausedAt) {
      return null
    }

    this.startedAt = Date.now()
    this.pausedAt = 0

    return null
  }

  getElapsedSeconds() {
    const elapsedMs = this.accumulatedMs + (this.pausedAt ? 0 : Date.now() - this.startedAt)

    return Math.max(Math.round(elapsedMs / 1000), 0)
  }

  getViewData() { return projectPractice(this) }

  getShareMessage() {
    return {
      title: this.state.practiceTitle || '题小搭练习',
      path: this.state.practicePath || '/page/practice/index'
    }
  }

  reset() {
    const questions = this.state.questions
    const firstQuestion = questions[0] || null
    const isViewMode = this.state.isViewMode

    // 重练是新的一轮，计时从零开始
    this.resetStudyClock()

    const patch = {
      currentIndex: 0,
      currentNumber: firstQuestion ? 1 : 0,
      currentQuestion: this.getQuestionView(firstQuestion, [], isViewMode),
      selectedKeys: [],
      answerText: '',
      blankInputs: Array.from({ length: firstQuestion && firstQuestion.blankCount || 0 }, (_, i) => ({ index: i, value: isViewMode ? (firstQuestion.blanks[i].answers || []).join(' / ') : '' })),
      answers: [],
      hasAnswered: false,
      shouldRevealAnswer: isViewMode,
      isCurrentAnswerCorrect: isViewMode,
      currentCorrectAnswerText: isViewMode ? this.getCorrectAnswerText(firstQuestion) : '',
      currentExplanation: isViewMode ? this.getExplanation(firstQuestion) : '',
      progressPercent: this.getProgressPercent(0),
      primaryActionText: this.getPrimaryActionText(0, false, []),
      isLastQuestion: questions.length <= 1,
      isCompleted: false,
      // 收藏是跨会话的持久数据，重练时保留
      favoriteQuestionIds: this.state.favoriteQuestionIds.slice(),
      isCurrentQuestionFavorite: firstQuestion
        ? this.state.favoriteQuestionIds.indexOf(firstQuestion.id) >= 0
        : false,
      // 标记属于本轮练习，重练时清空
      markedQuestionIds: [],
      isCurrentQuestionMarked: false,
      markedCount: 0,
      showSubmitModal: false,
      showQuestionOverview: false,
      unansweredCount: isViewMode ? 0 : questions.length,
      overviewItems: this.getOverviewItems([], 0),
      timerSeconds: this.state.durationSeconds,
      timerText: formatTimer(this.state.durationSeconds),
      correctCount: 0,
      score: null,
      scoreText: '已完成',
      objectiveAccuracyText: '—',
      answerLocked: isViewMode,
      pendingConfirmationCount: 0,
      wrongQuestionIds: [],
      wrongCount: 0,
      hasWrongQuestions: false,
      resultItems: [],
      resultFilter: RESULT_FILTERS.ALL,
      resultKeyword: '',
      filteredResultItems: [],
      resultFilterCounts: {
        all: 0,
        correct: 0,
        wrong: 0,
        unanswered: 0
      },
      resultFilterEmptyText: '暂无题目'
    }

    return this.updateState(patch, {
      startTimer: this.shouldStartTimerAfterPatch(patch),
      stopTimer: true
    })
  }

  updateTimer(timerSeconds) {
    const safeSeconds = Math.max(Number(timerSeconds) || 0, 0)

    this.state.timerSeconds = safeSeconds
    this.state.timerText = formatTimer(safeSeconds)
    return { data: { timerSeconds: safeSeconds, timerText: this.state.timerText } }
  }

  autoSubmit() {
    if (this.state.isCompleted) {
      return {
        stopTimer: true
      }
    }

    this.state.timerSeconds = 0
    this.state.timerText = formatTimer(0)

    this.confirmAllAnswers()

    return this.finish()
  }

  selectOption(selectedIndex) {
    const question = this.getCurrentBaseQuestion()
    if (!question || this.state.isCompleted || this.state.isViewMode || this.isAnswerLocked(question) || !question.options[selectedIndex]) return null
    const key = question.options[selectedIndex].key
    const selectedKeys = question.isMultiple ? this.toggleSelectedKey(this.state.selectedKeys, key) : [key]
    this.state.answers[this.state.currentIndex] = { questionId: question.id, selectedKeys, confirmed: false, isCorrect: false }
    this.state.selectedKeys = selectedKeys
    if (!question.isMultiple && this.state.feedback === 'IMMEDIATE') return this.commitCurrentAnswer(selectedKeys)
    return this.showQuestionAtIndex(this.state.currentIndex)
  }

  isAnswerLocked(question) {
    return this.state.isViewMode || this.state.isCompleted || this.state.feedback === 'IMMEDIATE' && !question.isShortAnswer && this.state.hasAnswered
  }

  hasInput(question, answer) {
    if (!answer) return false
    if (question.isShortAnswer) return !!(answer.text || '').trim()
    if (question.isFillBlank) return (answer.blanks || []).some(value => value.trim())
    return (answer.selectedKeys || []).length > 0
  }

  confirmAllAnswers() {
    this.state.answers = this.state.questions.map((question, index) => {
      const answer = this.state.answers[index]
      if (!this.hasInput(question, answer)) return null
      let isCorrect = false
      if (question.isFillBlank) isCorrect = gradeBlanks(question, answer.blanks)
      else if (!question.isShortAnswer) {
        const keys = (answer.selectedKeys || []).slice().sort()
        isCorrect = JSON.stringify(keys) === JSON.stringify(question.answerKeys.slice().sort())
      }
      return Object.assign({}, answer, { confirmed: true, isCorrect, unscored: !!question.isShortAnswer })
    })
  }

  toggleFavoriteQuestion() {
    const question = this.getCurrentBaseQuestion()

    if (!question) {
      return null
    }

    const favoriteQuestionIds = this.state.favoriteQuestionIds.slice()
    const favoriteIndex = favoriteQuestionIds.indexOf(question.id)
    const isCurrentQuestionFavorite = favoriteIndex === -1

    if (isCurrentQuestionFavorite) {
      favoriteQuestionIds.push(question.id)
    } else {
      favoriteQuestionIds.splice(favoriteIndex, 1)
    }

    const result = this.updateState({
      favoriteQuestionIds,
      isCurrentQuestionFavorite
    })

    result.value = isCurrentQuestionFavorite
    // 由 ViewModel 落盘，session 不直接依赖 storage
    result.saveFavorite = {
      id: question.id,
      value: isCurrentQuestionFavorite
    }

    return result
  }

  /**
   * 标记 / 取消标记当前题。
   * 与收藏不同，标记属于本轮练习，随会话一起落盘（getPersistedState 的 markedIds），
   * 换卷 / 重练时清空。
   */
  toggleMarkQuestion() {
    const question = this.getCurrentBaseQuestion()

    if (!question) {
      return null
    }

    const markedQuestionIds = this.state.markedQuestionIds.slice()
    const markIndex = markedQuestionIds.indexOf(question.id)
    const isCurrentQuestionMarked = markIndex === -1

    if (isCurrentQuestionMarked) {
      markedQuestionIds.push(question.id)
    } else {
      markedQuestionIds.splice(markIndex, 1)
    }

    const result = this.updateState({
      markedQuestionIds,
      isCurrentQuestionMarked,
      markedCount: markedQuestionIds.length
    })

    result.value = isCurrentQuestionMarked

    return result
  }

  goNext() {
    if (!this.state.questions.length) return null
    const question = this.getCurrentBaseQuestion()
    if (!this.state.isViewMode && question.isMultiple && this.state.feedback === 'IMMEDIATE' && !this.state.hasAnswered && !this.state.selectedKeys.length) return null

    if (this.shouldConfirmCurrentAnswer()) {
      return this.commitCurrentAnswer(this.state.selectedKeys)
    }

    if (this.state.isLastQuestion) {
      return this.state.isViewMode ? this.returnCommand() : this.submit()
    }

    return this.showQuestionAtIndex(this.state.currentIndex + 1)
  }

  goPrev() {
    if (this.state.currentIndex === 0) {
      return null
    }

    return this.showQuestionAtIndex(this.state.currentIndex - 1)
  }

  submit() {
    if (this.state.isViewMode) return this.returnCommand()
    const unansweredCount = this.getUnansweredIndexes(this.state.answers).length
    const pendingConfirmationCount = this.state.questions.filter((question, index) => this.hasInput(question, this.state.answers[index]) && this.state.answers[index].confirmed === false).length
    return this.updateState({ showSubmitModal: true, unansweredCount, pendingConfirmationCount, overviewItems: this.getOverviewItems(this.state.answers, this.state.currentIndex) })
  }

  closeSubmitModal() {
    return this.updateState({
      showSubmitModal: false
    })
  }

  openQuestionOverview() {
    const overviewItems = this.getOverviewItems(this.state.answers, this.state.currentIndex)
    return this.updateState({
      showSubmitModal: false,
      showQuestionOverview: true,
      unansweredCount: this.getUnansweredIndexes(this.state.answers).length,
      pendingConfirmationCount: overviewItems.filter(item => item.isDraft).length,
      overviewItems
    })
  }

  closeQuestionOverview() {
    return this.updateState({
      showQuestionOverview: false
    })
  }

  jumpToQuestion(index) {
    const nextIndex = Number(index)

    if (Number.isNaN(nextIndex) || nextIndex < 0 || nextIndex >= this.state.questions.length) {
      return null
    }

    return this.showQuestionAtIndex(nextIndex, {
      showQuestionOverview: false
    })
  }

  forceSubmit() {
    if (this.state.isCompleted) return this.finish()
    this.confirmAllAnswers()

    this.state.showSubmitModal = false
    this.state.showQuestionOverview = false
    return this.finish()
  }

  finish() { return finish(this) }

  showQuestionAtIndex(index, extraData) {
    const question = this.state.questions[index]
    const savedAnswer = this.state.answers[index] || null
    const selectedKeys = savedAnswer ? savedAnswer.selectedKeys || [] : []
    const hasAnswered = !!savedAnswer && savedAnswer.confirmed !== false
    // 模拟测试模式下不即时反馈，交卷后才统一公布答案
    const shouldRevealAnswer = !this.state.reviewPending && (this.state.isViewMode || (hasAnswered && this.state.feedback === 'IMMEDIATE' && !question.isShortAnswer))

    return this.updateState(Object.assign({
      currentIndex: index,
      currentNumber: index + 1,
      currentQuestion: this.getQuestionView(question, selectedKeys, shouldRevealAnswer),
      selectedKeys,
      answerText: savedAnswer ? savedAnswer.text || '' : '',
      blankInputs: Array.from({ length: question.blankCount || 0 }, (_, i) => ({ index: i, label: String.fromCharCode(9312 + i), value: this.state.isViewMode && !this.state.review ? ((question.blanks[i] || {}).answers || []).join(' / ') : savedAnswer && savedAnswer.blanks ? savedAnswer.blanks[i] || '' : '' })),
      hasAnswered,
      canAssessCurrent: !!this.state.review && !this.state.awaitingResult && question.isShortAnswer && hasAnswered,
      currentSelfAssessment: savedAnswer && savedAnswer.selfAssessment || '',
      answerLocked: this.state.isViewMode || this.state.isCompleted || (hasAnswered && this.state.feedback === 'IMMEDIATE' && !question.isShortAnswer),
      shouldRevealAnswer,
      isCurrentAnswerCorrect: this.state.isViewMode || (savedAnswer ? !!savedAnswer.isCorrect : false),
      currentCorrectAnswerText: shouldRevealAnswer ? this.getCorrectAnswerText(question) : '',
      currentExplanation: shouldRevealAnswer ? this.getExplanation(question) : '',
      progressPercent: this.getProgressPercent(index),
      primaryActionText: this.getPrimaryActionText(index, hasAnswered, selectedKeys),
      isLastQuestion: index >= this.state.questions.length - 1,
      isCurrentQuestionFavorite: question ? this.state.favoriteQuestionIds.indexOf(question.id) >= 0 : false,
      isCurrentQuestionMarked: question ? this.state.markedQuestionIds.indexOf(question.id) >= 0 : false,
      markedCount: this.state.markedQuestionIds.length
    }, extraData || {}))
  }

  commitCurrentAnswer(selectedKeys) {
    const question = this.getCurrentBaseQuestion()

    if (this.state.isCompleted || !question || this.isAnswerLocked(question) || (!question.isShortAnswer && !question.isFillBlank && !selectedKeys.length)) {
      return null
    }

    this.commitCurrentAnswerInternal(selectedKeys)
    const result = this.showQuestionAtIndex(this.state.currentIndex)
    if (this.preferences.autoNextWhenCorrect && this.state.feedback === 'IMMEDIATE' && !question.isShortAnswer && this.state.isCurrentAnswerCorrect && !this.state.isLastQuestion) result.autoAdvance = true
    return result
  }

  commitCurrentAnswerInternal(selectedKeys) {
    const question = this.getCurrentBaseQuestion()

    if (!question) {
      return
    }

    if (question.isFillBlank) {
      const previous = this.state.answers[this.state.currentIndex] || {}
      const blanks = previous.blanks || Array(question.blankCount).fill('')
      this.state.answers[this.state.currentIndex] = { questionId: question.id, blanks: blanks.slice(), selectedKeys: [], confirmed: true, isCorrect: gradeBlanks(question, blanks) }
      return
    }
    if (question.isShortAnswer) {
      const previous = this.state.answers[this.state.currentIndex] || {}
      this.state.answers[this.state.currentIndex] = { questionId: question.id, text: this.state.answerText, selectedKeys: [], confirmed: true, selfAssessment: previous.selfAssessment || null, unscored: true, isCorrect: false }
      return
    }
    const normalizedKeys = selectedKeys.slice().sort()
    const answerKeys = question.answerKeys.slice().sort()
    const isCorrect =
      normalizedKeys.length === answerKeys.length &&
      normalizedKeys.every((key, index) => key === answerKeys[index])

    this.state.answers[this.state.currentIndex] = {
      questionId: question.id,
      selectedKeys: normalizedKeys,
      isCorrect,
      confirmed: true
    }
    this.state.hasAnswered = true
    this.state.shouldRevealAnswer = this.state.feedback === 'IMMEDIATE'
    this.state.isCurrentAnswerCorrect = isCorrect
    this.state.currentCorrectAnswerText = this.getCorrectAnswerText(question)
    this.state.currentExplanation = this.getExplanation(question)
    this.state.currentQuestion = this.getQuestionView(question, normalizedKeys, this.state.feedback === 'IMMEDIATE')
    this.state.unansweredCount = this.getUnansweredIndexes(this.state.answers).length
    this.state.primaryActionText = this.getPrimaryActionText(this.state.currentIndex, true, normalizedKeys)
  }

  setAnswerText(text) {
    const question = this.getCurrentBaseQuestion()
    if (!question || !question.isShortAnswer || this.isAnswerLocked(question)) return null
    this.state.answerText = String(text || '').slice(0, 10000)
    this.state.answers[this.state.currentIndex] = { questionId: question.id, text: this.state.answerText, selectedKeys: [], confirmed: false, isCorrect: false }
    this.state.hasAnswered = false
    return { data: Object.assign({ primaryActionText: this.getPrimaryActionText(this.state.currentIndex, false, []) }, readingProgress(this)) }
  }

  setBlank(index, value) {
    const question = this.getCurrentBaseQuestion()
    if (!question || !question.isFillBlank || this.isAnswerLocked(question) || !Number.isInteger(index) || index < 0 || index >= question.blankCount) return null
    const previous = this.state.answers[this.state.currentIndex] || {}
    const blanks = previous.blanks ? previous.blanks.slice() : Array(question.blankCount).fill('')
    blanks[index] = String(value || '').slice(0, 500)
    this.state.blankInputs = this.state.blankInputs.map(input => input.index === index ? Object.assign({}, input, { value: blanks[index] }) : input)
    this.state.answers[this.state.currentIndex] = { questionId: question.id, blanks, selectedKeys: [], confirmed: false, isCorrect: false }
    this.state.hasAnswered = false
    return { data: Object.assign({ primaryActionText: this.getPrimaryActionText(this.state.currentIndex, false, []) }, readingProgress(this)) }
  }

  assessShortAnswer(value) {
    const question = this.getCurrentBaseQuestion()
    const answer = this.state.answers[this.state.currentIndex]
    if (!question || !question.isShortAnswer || !answer || !answer.confirmed || !this.state.isCompleted) return null
    answer.selfAssessment = value === 'CORRECT' ? 'CORRECT' : 'WRONG'
    answer.isCorrect = false
    return this.showQuestionAtIndex(this.state.currentIndex)
  }

  shouldConfirmCurrentAnswer() {
    const question = this.getCurrentBaseQuestion()

    return !!question && !question.isShortAnswer && this.state.feedback === 'IMMEDIATE' && !this.state.hasAnswered && this.hasConfirmableInput(question, this.state.currentIndex, this.state.selectedKeys)
  }

  hasConfirmableInput(question, index, keys) {
    const answer = this.state.answers[index] || {}
    if (question.isFillBlank) return (answer.blanks || []).some(value => value.trim())
    if (question.isShortAnswer) return !!(answer.text || '').trim()
    return question.isMultiple && keys.length > 0
  }

  updateState(patch, effects) {
    this.state = Object.assign({}, this.state, patch)

    const result = Object.assign({
      data: this.getViewData()
    }, effects || {})

    return result
  }

  getCurrentBaseQuestion() {
    return this.state.questions[this.state.currentIndex] || null
  }
  getQuestionView(question, selectedKeys, revealAnswer) { return getQuestionView(question, selectedKeys, revealAnswer) }
  getOverviewItems(answers, currentIndex) { return getOverviewItems(this, answers, currentIndex) }

  getUnansweredIndexes(answers) {
    return this.state.questions.reduce((items, question, index) => {
      if (!this.hasInput(question, answers[index])) {
        items.push(index)
      }

      return items
    }, [])
  }

  getProgressPercent(index) {
    if (!this.state.questions.length) {
      return 0
    }

    return Math.round(((index + 1) / this.state.questions.length) * 100)
  }

  /**
   * 主按钮文案。底部只保留「上一题 / 下一题」两个按钮，因此文案固定为翻页语义：
   * - 单选题未作答也可直接跳到下一题（该题记为未作答）；
   * - 多选题已勾选但未确认时，按钮暂变为「确认」，这是必要动作提示，不是冗余选项；
   * - 最后一题变为「交卷」（背题模式为「返回题库」）。
   */
  getPrimaryActionText(index, hasAnswered, selectedKeys) {
    const isLast = index >= this.state.questions.length - 1

    if (this.state.isViewMode) {
      return isLast ? '返回题库' : '下一题'
    }

    if (!hasAnswered) {
      const question = this.state.questions[index]

      if (question && !question.isShortAnswer && this.state.feedback === 'IMMEDIATE' && (question.isMultiple || this.hasConfirmableInput(question, index, selectedKeys))) {
        return '确认答案'
      }
    }

    return isLast ? '交卷' : '下一题'
  }

  shouldStartTimerAfterPatch(patch) {
    return this.state.isTimed && !patch.isCompleted
  }

  toggleSelectedKey(selectedKeys, key) {
    const nextKeys = selectedKeys.slice()
    const keyIndex = nextKeys.indexOf(key)

    if (keyIndex >= 0) {
      nextKeys.splice(keyIndex, 1)
    } else {
      nextKeys.push(key)
      nextKeys.sort()
    }

    return nextKeys
  }
  getAnswerText(question, keys) { return getAnswerText(question, keys) }
  getCorrectAnswerText(question) { return getCorrectAnswerText(question) }
  getExplanation(question) { return getExplanation(question) }

  returnCommand() {
    return {
      stopTimer: true,
      command: {
        type: 'returnBankDetail'
      }
    }
  }
}

module.exports = {
  DEFAULT_PRACTICE_TITLE,
  DEFAULT_TEST_DURATION_MINUTES,
  PRACTICE_MODES,
  PracticeSession,
  RESULT_FILTER_TEXT,
  RESULT_FILTERS,
  countResultItems,
  filterResultItems,
  formatTimer,
  getInitialPracticeViewData,
  normalizeMode,
  parsePositiveInteger
}
