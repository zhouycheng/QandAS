const { blankAnswerText } = require('../utils/fill-blank.js')
const { formatTimer } = require('./practice-view-data.js')
const { materialKey } = require('../utils/practice-layout.js')
function projectPractice(session) {
    const data = Object.assign({}, session.state)
    const key = materialKey(data.currentQuestion)
    const group = key ? session.state.questions.filter(q => materialKey(q) === key) : []
    data.readingGroupTotal = group.length
    data.readingGroupNumber = group.findIndex(q => q.id === (data.currentQuestion && data.currentQuestion.id)) + 1

    /**
     * 结果页要显示「用时」。
     * 注意它和考试模式的 timerText 不是一回事：那个是**剩余**时间，这个是**已消耗**时长。
     * 一旦交卷就把这一刻的读数冻住 —— 否则每秒 setData 都会重算，
     * 结果页上的「用时」会在用户盯着看的时候继续往上走。
     */
    if (data.isCompleted) {
      if (!session.frozenElapsedText) {
        session.frozenElapsedText = formatTimer(session.getElapsedSeconds())
      }

      data.elapsedText = session.frozenElapsedText
    } else {
      session.frozenElapsedText = ''
      data.elapsedText = formatTimer(session.getElapsedSeconds())
    }

    // 页面只接收展示投影，判题字段留在模型中。
    data.questions = session.state.questions.map(q => ({ id: q.id }))
    if (!data.isCompleted) {
      data.resultItems = []
      data.filteredResultItems = []
      data.answers = []
    }
    if (!data.isCompleted) data.overviewItems = data.overviewItems.map(item => Object.assign({}, item, { isCorrect: false }))
    if (!data.shouldRevealAnswer) {
      data.currentCorrectAnswerText = ''
      data.currentExplanation = ''
      data.isCurrentAnswerCorrect = false
    }
    return data
  }
function getQuestionView(question, selectedKeys, revealAnswer) {
    if (!question) {
      return null
    }

    return Object.assign({ contentFormat: question.contentFormat || 'PLAIN_TEXT', presentation: question.presentation || 'STANDARD', codeLanguage: question.codeLanguage || 'text', id: question.id, stem: question.stem, typeText: question.typeText, isShortAnswer: !!question.isShortAnswer, isFillBlank: !!question.isFillBlank, material: question.material || null, imagePaths: question.imagePaths || [], scoringPoints: revealAnswer ? question.scoringPoints || [] : [], assetIds: question.assetIds || [] }, {
      options: question.options.map((option) => ({
        key: option.key,
        label: option.label,
        text: option.text,
        selected: selectedKeys.indexOf(option.key) >= 0,
        isCorrectOption: revealAnswer ? question.answerKeys.indexOf(option.key) >= 0 : false,
        isWrongOption:
          revealAnswer && question.answerKeys.indexOf(option.key) < 0 && selectedKeys.indexOf(option.key) >= 0
      }))
    })
  }

function getOverviewItems(session, answers, currentIndex) {
    return session.state.questions.map((question, index) => ({
      number: index + 1,
      index,
      answered: session.hasInput(question, answers[index]) && (answers[index].confirmed !== false),
      isDraft: session.hasInput(question, answers[index]) && answers[index].confirmed === false,
      isShortAnswer: !!question.isShortAnswer,
      isCorrect: answers[index] ? !!answers[index].isCorrect : false,
      selectedKeys: answers[index] ? answers[index].selectedKeys : [],
      isCurrent: index === currentIndex,
      isFavorite: session.state.favoriteQuestionIds.indexOf(question.id) >= 0,
      isMarked: session.state.markedQuestionIds.indexOf(question.id) >= 0
    }))
  }

function getAnswerText(question, keys) {
    if (!question || !keys || !keys.length) {
      return ''
    }

    return keys
      .map((key) => {
        const option = question.options.find((item) => item.key === key)
        return option ? `${key}. ${option.text}` : key
      })
      .join('  ')
  }

function getCorrectAnswerText(question) {
    if (!question) {
      return ''
    }

    return question.isFillBlank ? blankAnswerText(question) : question.isShortAnswer ? question.referenceAnswer : `正确答案 ${question.answerKeys.join('')}`
  }

function getExplanation(question) {
    return question && question.explanation ? question.explanation : '本题暂无解析。'
  }

module.exports = { projectPractice, getQuestionView, getOverviewItems, getAnswerText, getCorrectAnswerText, getExplanation }
