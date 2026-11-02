const { formatTimer } = require('./practice-view-data.js')
function projectPractice(session) {
    const data = Object.assign({}, session.state)

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
module.exports = { projectPractice }
