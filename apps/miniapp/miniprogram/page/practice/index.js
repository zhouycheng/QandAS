const { viewPatch } = require('../../models/view-patch.js')
const { swipeDirection } = require('../../utils/question-swipe.js')
const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { PracticeViewModel } = require('../../viewmodels/practice-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const HOME_PAGE_URL = '/page/subject-list/index'

// 答对自动翻页的停留时间：需要留出看清「回答正确」与选项变绿的时间，
// 太短会让人来不及确认自己点对了
const AUTO_ADVANCE_DELAY = 800

Page(withPageLifecycle({
  data: Object.assign(PracticeViewModel.getInitialData(), {
    // 长解析默认收起（设计稿「剩下的收起来了」）。纯界面状态，不进 ViewModel：
    // 换题时由 applyViewModelResult 归零，和答题逻辑没有关系
    explanationOpen: false,
    questionScrollTop: 0
  }),

  onLoad(options) {
    this.viewModel = new PracticeViewModel({
      storage: createWxStorageAdapter()
    })
    this.routeOptions = options || {}
    this.applyViewModelResult(this.viewModel.load(options), 'loadingPractice')
  },

  onShow() {
    this.pageVisible = true
    this.observeSaveStatus()
    if (this.viewModel && this.viewModel.online) this.viewModel.online.activeId = (this.viewModel.session && this.viewModel.session.meta.sessionId) || ''
    if (this.viewModel) {
      this.applyViewModelResult(this.viewModel.resumeStudy())
        this.viewModel.checkWriter().then(result => this.applyViewModelResult(result)).catch(error => this.showSaveError(error))
    }
  },

  onHide() {
    this.pageVisible = false
    this.clearAutoAdvance()
    this.swipeStart = null
    if (this.stopSaveStatus) this.stopSaveStatus()
    this.stopSaveStatus = null
    if (this.viewModel && this.viewModel.online) this.viewModel.online.activeId = ''
    if (!this.viewModel) {
      return
    }

    // 切到后台：暂停累计，避免挂机把学习时长算虚
    this.viewModel.pauseStudy()
    // 主动退出也要落盘：用户可能从这里直接切走，之后再也不回来
    this.saveAndFlush()
  },

  onUnload() {
    this.pageVisible = false
    this.clearAutoAdvance()
    this.swipeStart = null
    if (this.stopSaveStatus) this.stopSaveStatus()
    this.stopSaveStatus = null
    if (this.viewModel && this.viewModel.online) this.viewModel.online.activeId = ''
    // 异常退出（杀进程 / 系统回收）不总会走 onHide，这里是最后一道保险
    if (this.viewModel) {
      this.saveAndFlush()
      const online = this.viewModel.online
      const session = this.viewModel.session
    }

    this.stopTestTimer()
    this.clearAutoAdvance()
  },

  saveAndFlush() {
    try {
      Promise.resolve(this.viewModel.saveSessionNow()).catch(error => this.showSaveError(error))
    } catch (error) { this.showSaveError(error) }
  },

  observeSaveStatus() {
    if (this.stopSaveStatus || this.pageVisible === false || !this.viewModel || !this.viewModel.online || !this.viewModel.session) return
    this.stopSaveStatus = this.viewModel.observeSaveStatus(data => { if (this.pageVisible !== false && !this._pageUnloaded) this.setData(data) })
  },
  retrySync() { this.applyViewModelResult(this.viewModel.retrySync()) },

  showSaveError(error) {
    wx.showToast({ title: error.message || '保存失败，请重试', icon: 'none' })
  },

  inputAnswerText(e) { this.applyViewModelResult(this.viewModel.setAnswerText(e.detail.value)) },
  inputBlank(e) { this.applyViewModelResult(this.viewModel.setBlank(Number(e.detail.index === undefined ? e.currentTarget.dataset.index : e.detail.index), e.detail.value)) },
  assessShortAnswer(e) { this.applyViewModelResult(this.viewModel.assessShortAnswer(e.currentTarget.dataset.value)) },

  assessResult(e) { this.applyViewModelResult(this.viewModel.assessResult(e.currentTarget.dataset.id, e.currentTarget.dataset.value)) },

  onShareAppMessage() {
    const state = this.viewModel && this.viewModel.session && this.viewModel.session.state
    const question = state && state.questions && state.questions[state.currentIndex]
    return { title: '题小搭 公开题目', path: question ? '/page/question-detail/index?id=' + encodeURIComponent(question.id) : '/page/subject-list/index' }
  },

  /** 答对自动翻页的定时器：用户手动操作时必须取消，否则会连翻两题 */
  clearAutoAdvance() {
    if (this.autoAdvanceTimer) {
      clearTimeout(this.autoAdvanceTimer)
      this.autoAdvanceTimer = null
    }
  },

  scheduleAutoAdvance() {
    this.clearAutoAdvance()
    const sessionId = this.data.sessionId
    const index = this.data.currentIndex
    this.autoAdvanceTimer = setTimeout(() => {
      this.autoAdvanceTimer = null
      if (this.pageVisible === false || this.data.sessionId !== sessionId || this.data.currentIndex !== index || this.data.editingLocked || this.data.isCompleted || this.data.showQuestionOverview || this.data.showSubmitModal) return
      this.goNext()
    }, AUTO_ADVANCE_DELAY)
  },

  ignoreSwipe() { this.swipeStart = null },
  onAnswerFocus() { this.answerFocused = true; this.ignoreSwipe() },
  onAnswerBlur() { this.answerFocused = false },
  onKeyboardHeight(e) { this.keyboardVisible = e.detail.height > 0; this.ignoreSwipe() },
  onTextSelection() { this.textSelectionActive = true; this.ignoreSwipe() },
  canSwipe() {
    return (this.data.isViewMode || this.data.feedback === 'AFTER_FINISH') && !this.data.isCompleted && !this.data.editingLocked && !this.data.waitingForSync && !this.data.showSubmitModal && !this.data.showQuestionOverview && !this.data.editLayout && !this.data.submitting && !this.answerFocused && !this.keyboardVisible && !this.textSelectionActive
  },
  onQuestionTouchStart(e) {
    this.swipeStart = null
    if (!this.canSwipe() || e.touches.length !== 1 || e.target && e.target.dataset && e.target.dataset.noSwipe) return
    const point = e.touches[0]
    const width = wx.getWindowInfo().windowWidth
    if (point.clientX < 24 || point.clientX > width - 24) return
    this.swipeStart = { x: point.clientX, y: point.clientY, at: Date.now() }
  },
  onQuestionTouchMove(e) {
    if (!this.swipeStart) return
    const point = e.touches[0]
    if (e.touches.length !== 1 || Math.abs(point.clientY - this.swipeStart.y) > Math.abs(point.clientX - this.swipeStart.x)) this.ignoreSwipe()
  },
  onQuestionTouchEnd(e) {
    const start = this.swipeStart
    this.swipeStart = null
    if (!start || !this.canSwipe() || e.changedTouches.length !== 1) return
    const point = e.changedTouches[0]
    const direction = swipeDirection(start, { x: point.clientX, y: point.clientY, at: Date.now() })
    if (direction === 1) {
      if (this.data.isLastQuestion) this.showHint('已经是最后一题了')
      else this.goNext()
    }
    if (direction === -1) {
      if (this.data.currentIndex === 0) this.showHint('已经是第一题了')
      else this.goPrev()
    }
  },

  showHint(message) { this.selectComponent('#practice-hint').show(message) },

  startTestTimer() {
    if (!this.data.isTimed || this.data.isCompleted || !this.data.questions.length) {
      return
    }

    this.stopTestTimer()
    this.testEndsAt = Date.now() + this.data.timerSeconds * 1000
    this.countdownTimer = setInterval(() => {
      if (this.data.editingLocked) return
      const timerSeconds = Math.max(Math.ceil((this.testEndsAt - Date.now()) / 1000), 0)
      this.applyViewModelResult(this.viewModel.updateTimer(timerSeconds))

      if (timerSeconds <= 0) {
        this.applyViewModelResult(this.viewModel.autoSubmit(), 'submitting')
      }
    }, 1000)
  },

  stopTestTimer() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
      this.countdownTimer = null
    }
  },

  selectOption(e) {
    if (this.data.editingLocked || this.data.waitingForSync) return
    const selectedIndex = Number(e.currentTarget.dataset.index)
    const result = this.viewModel.selectOption(selectedIndex)
    const preferences = this.data.preferences || {}

    // 震动反馈由学习偏好控制；机型或系统关闭震动时静默失败
    if (result && preferences.vibrateOnAnswer) {
      wx.vibrateShort({
        type: 'light',
        fail: () => {}
      })
    }

    // 先清掉可能残留的自动翻页，再看本次作答是否触发新的
    this.clearAutoAdvance()
    this.applyViewModelResult(result)

  },

  goNext() {
    this.textSelectionActive = false
    this.clearAutoAdvance()
    this.applyViewModelResult(this.viewModel.goNext())
  },

  goPrev() {
    this.textSelectionActive = false
    this.clearAutoAdvance()
    this.applyViewModelResult(this.viewModel.goPrev())
  },

  submitPractice() {
    if (this.data.submitting) return
    this.clearAutoAdvance()
    this.applyViewModelResult(this.viewModel.submit(), 'submitting')
  },

  forceSubmit() {
    if (this.data.submitting) return
    this.clearAutoAdvance()
    this.applyViewModelResult(this.viewModel.forceSubmit(), 'submitting')
  },

  closeSubmitModal() {
    this.applyViewModelResult(this.viewModel.closeSubmitModal())
  },

  openOverview() {
    this.clearAutoAdvance()
    this.applyViewModelResult(this.viewModel.openQuestionOverview())
  },

  closeOverview() {
    this.applyViewModelResult(this.viewModel.closeQuestionOverview())
  },

  jumpToQuestion(e) {
    const detailIndex = e.detail && e.detail.index
    const datasetIndex = e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.index
    const nextIndex = detailIndex !== undefined ? detailIndex : datasetIndex

    this.clearAutoAdvance()
    this.applyViewModelResult(this.viewModel.jumpToQuestion(nextIndex))
  },

  /** 答题卡里的「确认结束」：先收起弹层，再走正常交卷（未答完会弹二次确认） */
  handleOverviewSubmit() {
    if (!this.viewModel) {
      return
    }

    this.applyViewModelResult(this.viewModel.closeQuestionOverview())
    this.submitPractice()
  },

  /** 长解析的展开 / 收起 */
  toggleExplanation() {
    this.setData({
      explanationOpen: !this.data.explanationOpen
    })
  },

  toggleFavorite() {
    if (this.data.favoriteSaving) return
    const result = this.viewModel.toggleFavoriteQuestion()
    return this.applyViewModelResult(result, 'favoriteSaving')
  },

  /** 标记 / 取消标记当前题：和收藏一样给一句 toast，否则用户不知道点没点上 */
  toggleMark() {
    const result = this.viewModel.toggleMarkQuestion()
    this.applyViewModelResult(result)

    if (result && typeof result.value === 'boolean') {
      wx.showToast({
        title: result.value ? '已标记本题' : '已取消标记',
        icon: 'none',
        duration: 1200
      })
    }
  },

  /** 答题卡里的「看标记」：直接跳到第一个标记题，没有就提示 */
  jumpToFirstMarked() {
    const items = this.data.overviewItems || []
    const firstMarked = items.filter((item) => item.isMarked)[0]

    if (!firstMarked) {
      wx.showToast({
        title: '还没有标记的题目',
        icon: 'none',
        duration: 1200
      })
      return
    }

    this.applyViewModelResult(this.viewModel.closeQuestionOverview())
    this.jumpToQuestion({ detail: { index: firstMarked.index } })
  },

  restartPractice() {
    this.stopTestTimer()
    this.clearAutoAdvance()
    this.applyViewModelResult(this.viewModel.reset())
  },

  redoWrongQuestions() {
    this.applyViewModelResult(this.viewModel.createRedoWrongCommand(this.data.wrongQuestionIds))
  },

  returnBankDetail() {
    if (!this.saveBeforeLeaving()) return
    wx.navigateBack({
      fail: () => {
        navigation.switchTab({
          url: '/page/bank-detail/index'
        })
      }
    })
  },

  returnHome() {
    if (!this.saveBeforeLeaving()) return
    navigation.switchTab({
      url: HOME_PAGE_URL
    })
  },

  saveBeforeLeaving() {
    this.clearAutoAdvance()
    try {
      if (this.viewModel && !this.viewModel.editingLocked) this.viewModel.persistSession(true)
      return true
    } catch (error) { this.showSaveError(error); return false }
  },

  applyViewModelResult(result, busyKey) {
    if (!result) {
      return
    }

    if (typeof result.then === 'function') {
      if (busyKey) this.setData({ [busyKey]: true })
      return result.then(resolved => this.applyViewModelResult(resolved)).catch(error => {
        this.showSaveError(error)
        if (!this.viewModel.session) this.setData({ loadError: error.message || '练习加载失败，请重试' })
      }).finally(() => { if (busyKey && !this._pageUnloaded) this.setData({ [busyKey]: false }) })
    }

    const runEffects = () => {
      this.applyViewModelEffects(result)
      this.observeSaveStatus()
    }

    if (result.data) {
      if (this.pageVisible !== false && this.viewModel && this.viewModel.online) this.viewModel.online.activeId = (this.viewModel.session && this.viewModel.session.meta.sessionId) || ''
      const patch = Object.assign({}, result.data)

      // 原生输入在聚焦时保有光标；计时和同步更新不回写当前输入值。
      if (this.answerFocused && (patch.currentIndex === undefined || patch.currentIndex === this.lastQuestionIndex) && !patch.isCompleted) {
        delete patch.answerText
        delete patch.blankInputs
      }

      // 换题就把解析收回去：否则上一题展开的长解析会带到下一题
      if (patch.currentIndex !== undefined && patch.currentIndex !== this.lastQuestionIndex) {
        this.lastQuestionIndex = patch.currentIndex
        this.clearAutoAdvance()
        this.textSelectionActive = false
        patch.explanationOpen = !!patch.isViewMode
        patch.questionScrollTop = this.data.questionScrollTop === 0 ? 0.01 : 0
      }

      if (patch.editingLocked || patch.isCompleted || patch.showQuestionOverview || patch.showSubmitModal) this.clearAutoAdvance()
      this.setData(viewPatch(this.data, patch), runEffects)
      return
    }

    runEffects()
  },

  retrySubmit() {
    if (this.data.submitting) return
    return this.applyViewModelResult(this.viewModel.retrySubmit(), 'submitting')
  },

  handleResultFilter(e) {
    const filter = e.currentTarget.dataset.filter
    this.applyViewModelResult(this.viewModel.setResultFilter(filter))
  },

  handleResultSearch(e) {
    const keyword = e.detail && e.detail.value !== undefined ? e.detail.value : ''
    this.applyViewModelResult(this.viewModel.setResultKeyword(keyword))
  },

  handleOpenQuestionDetail(e) {
    const questionId = e.currentTarget.dataset.id
    this.applyViewModelResult(this.viewModel.createQuestionDetailCommand(questionId))
  },

  openFeedback() {
    this.applyViewModelResult(this.viewModel.openFeedback())
  },

  applyViewModelEffects(result) {
    if (result.autoAdvance) this.scheduleAutoAdvance()
    if (result.stopTimer) {
      this.stopTestTimer()
    }

    // 交卷同步失败：保留本地结果，只挂一条可重试的提示，不清 Session
    if (result.submitOk === false) {
      this.setData({
        submitError: result.submitError || '提交失败，请重试'
      })
      wx.showToast({
        title: result.submitError || '提交失败',
        icon: 'none'
      })
    }

    if (result.submitOk === true && this.data.submitError) {
      this.setData({
        submitError: ''
      })
    }

    if (result.command) {
      this.handleViewModelCommand(result.command)
    }

    if (result.startTimer) {
      this.startTestTimer()
    }
  },

  handleViewModelCommand(command) {
    if (command.type === 'toast') wx.showToast({ title: command.title, icon: 'none' })
    if (command.type === 'trialLogin') {
      wx.showModal({ title: '登录后继续练习', content: '本机的两次试答已使用。登录后返回题库配置，再开始正式练习。', confirmText: '去登录', cancelText: '继续浏览', success: result => {
        if (result.confirm) {
          try { createWxStorageAdapter().set('qandaPendingPractice', this.viewModel.routeOptions) }
          catch (error) { this.showSaveError(error); return }
          navigation.switchTab({ url: '/page/bank-detail/index', success: () => navigation.navigateTo({ url: '/page/login/index' }) })
        }
      } })
    }
    if (command.type === 'returnBankDetail') {
      this.returnBankDetail()
    }

    if (command.type === 'navigate' && command.url) {
      navigation.navigateTo({
        url: command.url,
        fail: () => {
          navigation.switchTab({
            url: HOME_PAGE_URL
          })
        }
      })
    }
  }
}))
