const { viewPatch } = require('../../models/view-patch.js')
const { swipeDirection } = require('../../utils/question-swipe.js')
const { allocateHeights, viewportHeight, resetScroll, materialKey } = require('../../utils/practice-layout.js')
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
    analysisSheetOpen: false,
    analysisSheetOffset: 0,
    analysisSheetHeight: 0,
    analysisAreaTop: 0,
    analysisAreaHeight: 0,
    analysisScrollTop: 0,
    analysisDragging: false,
    analysisSheetVersion: 0,
    analysisSuspended: false,
    practiceWindowHeight: 0,
    keyboardVisible: false,
    keyboardCompact: false,
    paneHeights: { material: 0, stem: 140, response: 220 },
    paneOverflow: {},
    readingLayout: false,
    readingOpen: false,
    readingRatio: 0.65,
    flowScrollTop: 0,
    readingVersion: 0,
    readingDragging: false,
    readingSuspended: false,
    readingGeometry: { height: 0, heading: 48 },
    readingQuestionScrollTop: 0,
    paneScroll: { material: 0, stem: 0, response: 0 }
  }),

  onLoad(options) {
    this.updateWindowHeight()
    this.viewModel = new PracticeViewModel({
      storage: createWxStorageAdapter()
    })
    this.routeOptions = options || {}
    this.practiceNetworkHandler = event => { if (event.isConnected) this.checkContentUpdates() }
    if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(this.practiceNetworkHandler)
    Promise.resolve(this.applyViewModelResult(this.viewModel.load(options), 'loadingPractice')).then(() => this.checkContentUpdates())
  },

  handleViewLatest(event) { this.applyViewModelResult(this.viewModel.viewLatestQuestion(event.currentTarget.dataset.id)) },
  checkContentUpdates() { if (this.viewModel && this.pageVisible !== false) this.viewModel.checkContentUpdates().then(result => { if (!this._pageUnloaded && this.pageVisible !== false) this.applyViewModelResult(result) }).catch(() => {}) },
  onForegroundReady() { this.checkContentUpdates(); this.updateWindowHeight(); this.scheduleMeasure() },
  onResize() { this.cancelReadingDrag(); this.setData({ analysisDragging: false, analysisSheetVersion: this.data.analysisSheetVersion + 1 }); this.updateWindowHeight(); this.scheduleMeasure() },

  updateWindowHeight() {
    if (typeof wx.getWindowInfo !== 'function') return
    const info = wx.getWindowInfo()
    if (!this.keyboardVisible && (!this.answerFocused || !this.fullWindowHeight || info.windowWidth !== this.fullWindowWidth || info.windowHeight >= this.fullWindowHeight)) {
      this.fullWindowHeight = info.windowHeight
      this.fullWindowWidth = info.windowWidth
    }
    this.setData({ practiceWindowHeight: viewportHeight(info.windowHeight, this.fullWindowHeight || info.windowHeight, this.keyboardHeight || 0) })
  },

  scheduleMeasure() {
    if (this._pageUnloaded || this.pageVisible === false || this.data.isCompleted) return
    clearTimeout(this.measureTimer)
    this.measureVersion = (this.measureVersion || 0) + 1
    this.measureTimer = setTimeout(() => { this.measureTimer = null; this.measurePanes() }, 0)
  },

  measurePanes() {
    if (this._pageUnloaded || this.pageVisible === false || this.data.isCompleted || !this.createSelectorQuery) return
    const question = this.data.currentQuestion
    if (!question) return
    if (this.data.readingLayout) return this.measureReadingPanes()
    if (!this.data.fixedLayout) return this.measureFlowPanes()
    const query = this.createSelectorQuery()
    query.select('.pra-content').fields({ size: true, computedStyle: ['padding-top', 'padding-bottom', 'row-gap'] })
    query.selectAll('.module-info, .module-tools').boundingClientRect()
    query.selectAll('.pra-pane-content').boundingClientRect()
    query.select('.pra-body').boundingClientRect()
    const currentIndex = this.data.currentIndex
    const version = this.measureVersion
    query.exec(results => {
      if (this._pageUnloaded || this.pageVisible === false || this.data.isCompleted || this.measureVersion !== version || this.data.currentIndex !== currentIndex || !results || !results[0]) return
      const [content, fixed, panes] = results
      const gap = parseFloat(content['row-gap']) || 0
      const material = !!question.material && !this.data.readingLayout && !this.keyboardVisible
      const response = !question.isFillBlank
      const moduleCount = 3 + Number(response) - Number(!!this.data.keyboardCompact)
      const fixedHeight = (fixed || []).reduce((sum, rect) => sum + rect.height, 0)
      const height = content.height - fixedHeight - (parseFloat(content['padding-top']) || 0) - (parseFloat(content['padding-bottom']) || 0) - gap * (moduleCount - 1 + Number(material))
      if (this.keyboardVisible && height < 64 && !this.data.keyboardCompact) {
        this.setData({ keyboardCompact: true }, () => this.scheduleMeasure())
        return
      }
      const contentHeights = {}
      ;(panes || []).forEach(rect => { contentHeights[rect.dataset.pane] = rect.height })
      if (question.isShortAnswer) contentHeights.response = Infinity
      const layout = allocateHeights({ height, material, response, contentHeights, keyboard: !!this.keyboardVisible, stemPercent: this.data.preferences.practiceStemPercent })
      const patch = viewPatch(this.data, { paneHeights: layout.heights, paneOverflow: layout.overflow })
      const body = results[3]
      Object.assign(patch, this.analysisMeasurement(body))
      if (this.keyboardScrollRestore) {
        patch.paneScroll = {}
        Object.keys(this.data.paneScroll).forEach(pane => {
          const value = this.keyboardScrollRestore[pane] || 0
          patch.paneScroll[pane] = this.data.paneScroll[pane] === value ? value + 0.01 : value
        })
        this.panePositions = Object.assign({}, patch.paneScroll)
        this.keyboardScrollRestore = null
      }
      if (Object.keys(patch).length) this.setData(patch, () => this.revealFocusedBlank())
      else this.revealFocusedBlank()
    })
  },

  measureFlowPanes() {
    const version = this.measureVersion, index = this.data.currentIndex
    const query = this.createSelectorQuery()
    ;['.pra-flow-scroll', '.module-stem .pra-stem', '.module-response textarea'].forEach(selector => query.select(selector).boundingClientRect())
    query.exec(rects => {
      if (this._pageUnloaded || this.pageVisible === false || version !== this.measureVersion || index !== this.data.currentIndex || !rects || !rects[0]) return
      const [viewport, stem, input] = rects
      this.flowHeight = viewport.height
      this.flowStemOffset = stem ? stem.top - viewport.top + (this.flowPosition || 0) : 0
      this.flowInputOffset = input ? input.top - viewport.top + (this.flowPosition || 0) : 0
      const restore = this.keyboardScrollRestore
      if (restore) {
        const target = restore.flow || 0
        this.keyboardScrollRestore = null
        this.setData({ flowScrollTop: this.data.flowScrollTop === target ? target + 0.01 : target })
      }
      this.revealFocusedBlank()
    })
  },
  onFlowScroll(event) { this.flowPosition = event.detail.scrollTop; this.clearAutoAdvance() },

  analysisDefaultOffset(height = this.data.analysisSheetHeight, areaHeight = this.data.analysisAreaHeight) {
    return Math.min(0, Math.floor(areaHeight * 0.5) - height)
  },

  analysisMeasurement(body) {
    if (!this.data.legacyAnalysisEnabled || !body || this.data.analysisDragging) return {}
    const height = Math.max(44, Math.floor(body.height * 0.7))
    const visible = this.data.analysisSheetHeight + this.data.analysisSheetOffset
    const offset = !this.data.analysisSheetOpen ? -height
      : this.data.analysisSheetOffset === this.analysisDefaultOffset() ? this.analysisDefaultOffset(height, body.height)
        : this.data.analysisSheetOffset === 0 ? 0 : Math.max(-height, Math.min(0, visible - height))
    return viewPatch(this.data, { analysisAreaTop: body.top, analysisAreaHeight: body.height, analysisSheetHeight: height, analysisSheetOffset: offset })
  },

  measureReadingPanes() {
    const version = this.measureVersion, index = this.data.currentIndex
    const query = this.createSelectorQuery()
    ;['.reading-workspace', '.reading-question-heading', '.reading-question', '.reading-question-content .pra-stem', '.reading-response'].forEach(selector => query.select(selector).boundingClientRect())
    query.exec(rects => {
      if (this._pageUnloaded || this.pageVisible === false || version !== this.measureVersion || index !== this.data.currentIndex || !rects || !rects[0] || this.data.readingDragging) return
      const [workspace, heading, question, stem, response] = rects
      const geometry = { height: workspace.height, heading: heading ? heading.height : 48 }
      const scroll = this.readingQuestionPosition || 0
      if (stem && question) this.readingStemOffset = stem.top - question.top + scroll
      if (response && question) this.readingResponseOffset = response.top - question.top + scroll
      const patch = viewPatch(this.data, { readingGeometry: geometry })
      if (this.keyboardScrollRestore) {
        const value = this.keyboardScrollRestore.material || 0
        patch['paneScroll.material'] = this.data.paneScroll.material === value ? value + 0.01 : value
        const questionScroll = this.readingKeyboardScroll || 0
        patch.readingQuestionScrollTop = this.data.readingQuestionScrollTop === questionScroll ? questionScroll + 0.01 : questionScroll
        this.keyboardScrollRestore = null
      }
      this.setData(patch, () => this.revealFocusedBlank())
    })
  },

  onReadingQuestionScroll(event) { this.readingQuestionPosition = event.detail.scrollTop; this.clearAutoAdvance() },

  onPaneScroll(event) {
    if (!this.panePositions) this.panePositions = {}
    this.panePositions[event.currentTarget.dataset.pane] = event.detail.scrollTop
    this.clearAutoAdvance()
  },

  revealFocusedBlank() {
    if (!this.keyboardVisible || !this.answerFocused) return
    if (this.data.readingLayout) {
      const current = this.readingQuestionPosition || 0
      const visible = this.data.readingGeometry.height
      if (visible <= 0) return
      const top = this.focusedBlank ? (this.readingStemOffset || 0) + this.focusedBlank.top : this.readingResponseOffset || 0
      const height = this.focusedBlank ? this.focusedBlank.height : Math.min(140, visible)
      const target = top < current ? top : top + height > current + visible - 12 ? Math.max(0, top + height - visible + 12) : current
      if (target !== current) this.setData({ readingQuestionScrollTop: target })
      return
    }
    if (!this.data.fixedLayout) {
      const current = this.flowPosition || 0, visible = this.flowHeight || 0
      if (!visible) return
      const top = this.focusedBlank ? (this.flowStemOffset || 0) + this.focusedBlank.top : this.flowInputOffset || 0
      const height = this.focusedBlank ? this.focusedBlank.height : Math.min(140, visible)
      const target = top < current ? top : top + height > current + visible - 12 ? Math.max(0, top + height - visible + 12) : current
      if (target !== current) this.setData({ flowScrollTop: target })
      return
    }
    if (!this.focusedBlank) return
    const { top, height } = this.focusedBlank
    const current = this.panePositions && this.panePositions.stem || 0
    const visible = this.data.paneHeights.stem
    const target = top < current ? top : top + height > current + visible - 12 ? Math.max(0, top + height - visible + 12) : current
    if (target !== current) this.setData({ 'paneScroll.stem': target })
  },

  onShow() {
    this.pageVisible = true
    this.checkContentUpdates()
    this.setData({ analysisSuspended: false, readingSuspended: false })
    this.textSelectionActive = false
    this.startElapsedTimer()
    this.observeSaveStatus()
    if (this.viewModel && this.viewModel.online) this.viewModel.online.activeId = (this.viewModel.session && this.viewModel.session.meta.sessionId) || ''
    if (this.viewModel) {
      this.applyViewModelResult(this.viewModel.resumeStudy())
        this.viewModel.checkWriter().then(result => this.applyViewModelResult(result)).catch(error => this.showSaveError(error))
    }
  },

  onHide() {
    this.rememberReadingMaterial()
    this.cancelReadingDrag()
    this.setData({ readingSuspended: true })
    this.setData({ analysisSuspended: true, analysisSheetOpen: false, analysisDragging: false, analysisSheetOffset: -this.data.analysisSheetHeight, analysisSheetVersion: this.data.analysisSheetVersion + 1 })
    this.stopElapsedTimer()
    clearTimeout(this.measureTimer)
    if (this.keyboardVisible) this.keyboardScrollRestore = this.keyboardPanePositions
    this.keyboardVisible = false
    this.keyboardHeight = 0
    this.answerFocused = false
    this.focusedBlank = null
    this.setData({ keyboardVisible: false, keyboardCompact: false })
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
    if (wx.offNetworkStatusChange && this.practiceNetworkHandler) wx.offNetworkStatusChange(this.practiceNetworkHandler)
    this.stopElapsedTimer()
    clearTimeout(this.measureTimer)
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
    this.stopSaveStatus = this.viewModel.observeSaveStatus(data => {
      const changed = data.canRetrySync !== this.data.canRetrySync || data.saveStatusText !== this.data.saveStatusText
      if (this.pageVisible !== false && !this._pageUnloaded) this.setData(data, () => { if (changed) this.scheduleMeasure() })
    })
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
      this.goNext(null, true)
    }, AUTO_ADVANCE_DELAY)
  },

  ignoreSwipe() { this.swipeStart = null },
  onAnswerFocus(event) {
    this.answerFocused = true
    if (event && event.detail && event.detail.offsetTop !== undefined) this.focusedBlank = { top: event.detail.offsetTop, height: event.detail.height }
    this.ignoreSwipe()
    this.revealFocusedBlank()
  },
  onAnswerBlur() { this.answerFocused = false; this.focusedBlank = null },
  onKeyboardHeight(e) {
    const height = Math.max(0, e.detail.height || 0)
    if (height > 0 && !this.keyboardVisible) {
      this.keyboardPanePositions = Object.assign({ flow: this.flowPosition || 0 }, this.panePositions)
      this.readingKeyboardScroll = this.readingQuestionPosition || 0
    }
    if (!height && this.keyboardVisible) this.keyboardScrollRestore = this.keyboardPanePositions
    this.keyboardHeight = height
    this.keyboardVisible = this.keyboardHeight > 0
    if (this.keyboardVisible) this.closeAnalysis()
    this.ignoreSwipe()
    this.cancelReadingDrag()
    this.setData({ keyboardVisible: this.keyboardVisible, keyboardCompact: false }, () => { this.updateWindowHeight(); this.scheduleMeasure() })
  },
  onTextSelection() { this.textSelectionActive = true; this.ignoreSwipe() },
  onQuestionTap() { if (this.textSelectionActive) { this.textSelectionActive = false; this.ignoreSwipe() } },
  cancelReadingDrag() {
    this.setData({ readingDragging: false, readingVersion: this.data.readingVersion + 1 })
  },
  rememberReadingMaterial() {
    const key = materialKey(this.data.currentQuestion)
    if (!key) return
    if (!this.readingMaterials) this.readingMaterials = new Map()
    this.readingMaterials.set(key, { open: this.data.readingOpen, ratio: this.data.readingRatio, scroll: this.panePositions && this.panePositions.material || 0 })
  },
  setReadingOpen(open) {
    if (!this.data.readingLayout || this.keyboardVisible || this.data.readingSuspended || this.data.editingLocked) return
    this.clearAutoAdvance()
    this.ignoreSwipe()
    this.setData({ readingOpen: open, readingDragging: false, readingVersion: this.data.readingVersion + 1 })
  },
  openReading() { this.setReadingOpen(true) },
  closeReading() { this.setReadingOpen(false) },
  toggleReadingHeight() {
    if (!this.data.readingOpen || this.keyboardVisible) return
    this.clearAutoAdvance()
    this.setData({ readingRatio: this.data.readingRatio > 0.75 ? 0.65 : 0.9, readingDragging: false, readingVersion: this.data.readingVersion + 1 })
  },
  onReadingHandleStart({ version }) {
    if (version !== this.data.readingVersion || this.pageVisible === false || this._pageUnloaded) return
    this.ignoreSwipe()
    this.clearAutoAdvance()
    this.setData({ readingDragging: true })
  },
  onReadingHandleEnd({ ratio, version }) {
    if (version !== this.data.readingVersion || this.pageVisible === false || this._pageUnloaded || !Number.isFinite(ratio)) return
    this.setData({ readingRatio: Math.max(0.35, Math.min(0.9, ratio)), readingDragging: false })
  },
  canSwipe() {
    return !!this.data.preferences.swipeEnabled && !this.data.isCompleted && !this.data.editingLocked && !this.data.waitingForSync && !this.data.showSubmitModal && !this.data.showQuestionOverview && !this.data.editLayout && !this.data.submitting && !this.answerFocused && !this.keyboardVisible && !this.textSelectionActive && !this.data.readingDragging
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
      else this.navigateNext(true, false)
    }
    if (direction === -1) {
      if (this.data.currentIndex === 0) this.showHint('已经是第一题了')
      else this.goPrev()
    }
  },

  showHint(message) { this.selectComponent('#practice-hint').show(message) },

  startElapsedTimer() {
    if (this.elapsedTimer || this._pageUnloaded || this.pageVisible === false || this.data.editingLocked || this.data.isTimed || this.data.isCompleted || !this.data.questions.length) return
    this.elapsedTimer = setInterval(() => this.applyViewModelResult(this.viewModel.tickElapsed()), 1000)
  },
  stopElapsedTimer() { clearInterval(this.elapsedTimer); this.elapsedTimer = null },

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

  goNext(event, automatic = false) { return this.navigateNext(false, automatic) },

  navigateNext(bySwipe, automatic) {
    this.textSelectionActive = false
    this.clearAutoAdvance()
    const source = this.data
    const index = source.currentIndex, key = materialKey(source.currentQuestion)
    const count = source.readingGroupUnansweredCount, sessionId = source.sessionId
    const remind = !automatic && source.readingLayout && !source.readingOpen && !source.isViewMode && source.readingGroupUnansweredCount > 0
    const result = this.viewModel.goNext(bySwipe)
    const apply = resolved => {
      this.applyViewModelResult(resolved)
      if (remind && resolved && !resolved.command && this.data.sessionId === sessionId && this.data.currentIndex === index + 1 && !this.data.isCompleted && !this.data.showSubmitModal) {
        const same = key === materialKey(this.data.currentQuestion)
        this.showHint(`${same ? '本篇' : '上一篇'}还有 ${count} 道小题未答`)
      }
    }
    if (result && typeof result.then === 'function') return result.then(apply).catch(error => this.showSaveError(error))
    apply(result)
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

  setAnalysisOpen(open) {
    if (!this.data.legacyAnalysisEnabled) return
    if (open && (!this.data.shouldRevealAnswer || !this.data.hasAnswered || this.data.feedback !== 'IMMEDIATE' || this.data.isViewMode || this.data.isCompleted || this.data.analysisSuspended)) return
    this.clearAutoAdvance()
    this.ignoreSwipe()
    this.setData({ analysisSheetOpen: open, analysisDragging: false, analysisSheetOffset: open ? this.analysisDefaultOffset() : -this.data.analysisSheetHeight, analysisSheetVersion: this.data.analysisSheetVersion + 1 })
  },
  closeAnalysis() { this.setAnalysisOpen(false) },
  toggleAnalysis() { this.setAnalysisOpen(!this.data.analysisSheetOpen) },
  blockAnalysisTouch() {},
  onAnalysisHandleStart({ version }) {
    if (version !== this.data.analysisSheetVersion || this._pageUnloaded || this.pageVisible === false) return
    this.clearAutoAdvance()
    this.ignoreSwipe()
    this.setData({ analysisDragging: true })
  },
  onAnalysisHandleEnd({ offset, version }) {
    if (version !== this.data.analysisSheetVersion || this._pageUnloaded || this.pageVisible === false || !Number.isFinite(offset)) return
    offset = Math.max(-this.data.analysisSheetHeight, Math.min(0, offset))
    this.setData({ analysisSheetOffset: offset, analysisSheetOpen: offset > -this.data.analysisSheetHeight, analysisDragging: false }, () => this.scheduleMeasure())
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

      const sessionChanged = patch.sessionId !== undefined && patch.sessionId !== this.data.sessionId
      const questionChanged = patch.currentIndex !== undefined && (patch.currentIndex !== this.lastQuestionIndex || sessionChanged)
      if (questionChanged) {
        this.rememberReadingMaterial()
        if (sessionChanged) this.readingMaterials = new Map()
        this.lastQuestionIndex = patch.currentIndex
        this.clearAutoAdvance()
        this.textSelectionActive = false
        patch.analysisSheetVersion = this.data.analysisSheetVersion + 1
        patch.analysisDragging = false
        patch.analysisScrollTop = this.data.analysisScrollTop === 0 ? 0.01 : 0
        patch.analysisSheetOpen = false
        patch.analysisSheetOffset = -this.data.analysisSheetHeight
        patch.readingLayout = !!(patch.currentQuestion && patch.currentQuestion.material)
        const key = materialKey(patch.currentQuestion)
        const saved = this.readingMaterials && this.readingMaterials.get(key)
        patch.readingOpen = saved ? saved.open : false
        patch.readingRatio = saved ? saved.ratio : 0.65
        patch.flowScrollTop = this.data.flowScrollTop === 0 ? 0.01 : 0
        this.flowPosition = 0
        patch.readingVersion = this.data.readingVersion + 1
        patch.readingDragging = false
        patch.readingQuestionScrollTop = this.data.readingQuestionScrollTop === 0 ? 0.01 : 0
        this.readingQuestionPosition = 0
        patch.paneScroll = resetScroll(this.data.currentQuestion, patch.currentQuestion, this.data.paneScroll, this.panePositions || {})
        if (saved) patch.paneScroll.material = this.data.paneScroll.material === saved.scroll ? saved.scroll + 0.01 : saved.scroll
        this.panePositions = Object.assign({}, patch.paneScroll)
        this.focusedBlank = null
        this.keyboardScrollRestore = null
      }

      const next = Object.assign({}, this.data, patch)
      patch.fixedLayout = next.preferences.layoutMode === 'custom'
      if (next.legacyAnalysisEnabled && next.shouldRevealAnswer && next.hasAnswered && next.feedback === 'IMMEDIATE' && !next.isViewMode && !next.isCompleted && next.preferences.autoOpenAnalysis && !result.autoAdvance && (questionChanged || !this.data.shouldRevealAnswer)) {
        patch.analysisSheetOpen = true
        patch.analysisSheetOffset = this.analysisDefaultOffset()
      }
      if (next.legacyAnalysisEnabled && (!next.shouldRevealAnswer || next.isCompleted || next.showQuestionOverview || next.showSubmitModal || next.editingLocked)) {
        patch.analysisSheetVersion = this.data.analysisSheetVersion + 1
        patch.analysisSheetOpen = false
        patch.analysisDragging = false
        patch.analysisSheetOffset = -this.data.analysisSheetHeight
      }

      if (patch.analysisSheetOpen || next.isCompleted || next.showQuestionOverview || next.showSubmitModal || next.editingLocked) {
        patch.readingDragging = false
        patch.readingVersion = this.data.readingVersion + 1
      }

      if (patch.editingLocked || patch.isCompleted || patch.showQuestionOverview || patch.showSubmitModal) this.clearAutoAdvance()
      const layoutChanged = ['currentQuestion', 'currentIndex', 'shouldRevealAnswer', 'loadingPractice', 'preferences', 'trialNotice', 'canRetrySync', 'saveStatusText', 'isCompleted'].some(key => patch[key] !== undefined)
      if (patch.analysisSheetOpen !== undefined && patch.analysisSheetOpen !== this.data.analysisSheetOpen) patch.analysisSheetVersion = this.data.analysisSheetVersion + 1
      this.setData(viewPatch(this.data, patch), () => { runEffects(); if (layoutChanged) this.scheduleMeasure() })
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
    if (this.data.isCompleted || this.data.editingLocked || this.data.isTimed) this.stopElapsedTimer()
    else this.startElapsedTimer()
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
