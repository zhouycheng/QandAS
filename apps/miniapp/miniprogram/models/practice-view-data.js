const { normalizePreferences } = require('../utils/preferences.js')
const { ranks } = require('../utils/practice-layout.js')
const { SESSION_STATUS, SYNC_STATUS } = require('./practice-session-state.js')
const { RESULT_FILTERS } = require('./practice-results.js')
const DEFAULT_PRACTICE_TITLE = '题库练习'

const DEFAULT_TEST_DURATION_MINUTES = 10

const PRACTICE_MODES = {
  ORDER: 'order',
  PRACTICE: 'practice',
  VIEW: 'view',
  TEST: 'test'
}

function formatTimer(totalSeconds) {
  const safeSeconds = Math.max(Number(totalSeconds) || 0, 0)
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  const secondText = seconds < 10 ? `0${seconds}` : `${seconds}`

  return `${minutes}:${secondText}`
}

function getInitialPracticeViewData() {
  const durationSeconds = DEFAULT_TEST_DURATION_MINUTES * 60

  return {
    loadError: '',
    loadingPractice: false,
    submitting: false,
    favoriteSaving: false,
    editingLocked: false,
    answerText: '',
    blankInputs: [],
    mode: PRACTICE_MODES.PRACTICE,
    // 初始即给一份默认偏好：页面首帧就要读 preferences.fontSize，
    // 缺了会让答题卡入口闪一下、字号也来不及生效
    preferences: normalizePreferences(null),
    layoutRanks: ranks(),
    editLayout: false,
    dragId: '',
    dragTarget: '',
    moduleLabels: {},
    trialNotice: '',
    // 页面根据练习状态显示恢复与同步提示。
    sessionId: '',
    sessionStatus: SESSION_STATUS.IN_PROGRESS,
    syncStatus: SYNC_STATUS.LOCAL_ONLY,
    // 交卷失败时的提示文案；为空表示同步正常，结果区不显示重试条
    submitError: '',
    // 结果复盘的筛选与搜索。
    resultFilter: RESULT_FILTERS.ALL,
    resultKeyword: '',
    filteredResultItems: [],
    resultFilterCounts: {
      all: 0,
      correct: 0,
      wrong: 0,
      unanswered: 0,
      review: 0,
      unscored: 0
    },
    resultFilterEmptyText: '暂无题目',
    isViewMode: false,
    isTestMode: false,
    isTimed: false,
    feedback: 'IMMEDIATE',
    answerLocked: false,
    pendingConfirmationCount: 0,
    objectiveCount: 0,
    objectiveAccuracyText: '—',
    scoreText: '已完成',
    subjectId: '',
    bankId: '',
    practiceTitle: DEFAULT_PRACTICE_TITLE,
    practiceModeText: '',
    practicePath: '/page/practice/index',
    questions: [],
    total: 0,
    currentIndex: 0,
    currentNumber: 0,
    currentQuestion: null,
    readingGroupTotal: 0,
    readingGroupNumber: 0,
    readingGroupUnansweredCount: 0,
    readingGroupDraftCount: 0,
    selectedKeys: [],
    answers: [],
    hasAnswered: false,
    shouldRevealAnswer: false,
    isCurrentAnswerCorrect: false,
    currentCorrectAnswerText: '',
    currentExplanation: '',
    progressPercent: 0,
    primaryActionText: '下一题',
    isLastQuestion: false,
    isCompleted: false,
    favoriteQuestionIds: [],
    isCurrentQuestionFavorite: false,
    // 「标记」= 做题时给可疑题打个记号，稍后回看。与收藏分开：
    // 收藏是长期资产（跨会话），标记属于这一轮练习
    markedQuestionIds: [],
    isCurrentQuestionMarked: false,
    markedCount: 0,
    wrongQuestionIds: [],
    wrongCount: 0,
    hasWrongQuestions: false,
    showSubmitModal: false,
    showQuestionOverview: false,
    unansweredCount: 0,
    overviewItems: [],
    durationSeconds,
    timerSeconds: durationSeconds,
    timerText: formatTimer(durationSeconds),
    // 结果页「用时」：已消耗时长（timerText 在考试模式下是剩余时间，两者不能混用）
    elapsedText: formatTimer(0),
    correctCount: 0,
    score: 0,
    bestScore: 0,
    resultItems: []
  }
}
module.exports = { DEFAULT_PRACTICE_TITLE, DEFAULT_TEST_DURATION_MINUTES, PRACTICE_MODES, formatTimer, getInitialPracticeViewData }
