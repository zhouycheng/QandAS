const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const { FeedbackViewModel } = require('../../viewmodels/feedback-viewmodel.js')
const remote = require('../../repositories/remote-data-repository.js')
Page(withPageLifecycle({
  data: FeedbackViewModel.getInitialData(),
  onLoad(options) {
    this.storage = createWxStorageAdapter()
    this.viewModel = new FeedbackViewModel({ storage: this.storage })
    this.applyViewModelResult(this.viewModel.load(options || {}))
  },
  onShow() {
    this.feedbackActive = true
    if (!this.viewModel.isCurrent()) {
      this.viewModel = new FeedbackViewModel({ storage: this.storage })
      this.applyViewModelResult(this.viewModel.load({ kind: this.data.kind }))
    }
    remote.refreshFeedbackSummary(this.storage).catch(() => {})
    if (!this.data.compose) return this.handleRetry()
  },
  onForegroundReady() { this.observeReplies() },
  onResize() { this.observeReplies() },
  onHide() { this.feedbackActive = false; this.stopObserving(); this.viewModel.cancel() },
  onUnload() { this.feedbackActive = false; this.stopObserving(); this.viewModel.cancel() },
  stopObserving() {
    this.feedbackEpoch = (this.feedbackEpoch || 0) + 1
    if (this.replyObserver) this.replyObserver.disconnect()
    this.replyObserver = null
    clearTimeout(this.readTimer)
    this.readTimer = null
    this.readQueue = new Map()
  },
  observeReplies() {
    if (!this.feedbackActive || !this._viewReady || this.data.loading || this.data.compose || !this.viewModel.isCurrent()) return
    this.stopObserving()
    if (!this.data.items.some(item => item.unread && item.response)) return
    const epoch = this.feedbackEpoch
    const current = () => this.feedbackActive && this.feedbackEpoch === epoch && this.viewModel.isCurrent()
    const query = this.createSelectorQuery()
    query.select('.feedback-footer').boundingClientRect()
    query.exec(rects => {
      if (!current()) return
      const height = wx.getWindowInfo().windowHeight
      const footer = rects[0]
      this.replyObserver = this.createIntersectionObserver({ observeAll: true, thresholds: [0] })
      this.replyObserver.relativeTo('.feedback-page').relativeToViewport({ bottom: footer ? -Math.max(0, height - footer.top) : 0 })
        .observe('.reply-unread', result => {
          if (!current() || result.intersectionRatio <= 0) return
          const row = this.data.items.find(item => item.id === result.dataset.id && item.version === Number(result.dataset.version) && item.unread)
          if (!row) return
          this.readQueue.set(row.id, { id: row.id, version: row.version })
          this.scheduleReads()
        })
    })
  },
  scheduleReads() {
    if (this.readTimer || this.readInFlight || !this.readQueue.size) return
    this.readTimer = setTimeout(() => this.flushReads(), 40)
  },
  flushReads() {
    clearTimeout(this.readTimer)
    this.readTimer = null
    if (!this.feedbackActive || this.readInFlight || !this.viewModel.isCurrent() || !this.readQueue.size) return
    const epoch = this.feedbackEpoch
    const items = Array.from(this.readQueue.values())
    this.readQueue.clear()
    const current = () => this.feedbackActive && this.feedbackEpoch === epoch && this.viewModel.isCurrent()
    const pending = this.viewModel.acknowledge(items, current).then(result => { if (current()) this.applyViewModelResult(result) }).finally(() => {
      if (this.readInFlight === pending) this.readInFlight = null
      if (this.feedbackActive) this.scheduleReads()
    })
    this.readInFlight = pending
    return pending
  },
  handleInput(event) {
    const key = event.currentTarget.dataset.key
    if (key === 'body' || key === 'courseName') this.setData({ [key]: event.detail.value })
  },
  handleCategory(event) {
    this.setData({ categoryIndex: Number(event.detail.value) })
  },
  handleKind(event) {
    if (this.data.saving) return
    this.stopObserving()
    this.viewModel.kind = event.currentTarget.dataset.kind
    this.setData({ kind: this.viewModel.kind, items: [], page: 1, compose: false })
    this.handleRetry()
  },
  handleCompose() {
    this.stopObserving()
    this.setData({ compose: true, courseName: '', body: '' })
  },
  handleRetry() {
    this.stopObserving()
    this.setData({ loading: true })
    return this.applyViewModelResult(this.viewModel.list(this.data.page))
  },
  handlePage(event) {
    if (this.data.loading) return
    this.setData({ page: Math.max(1, this.data.page + Number(event.currentTarget.dataset.step)) })
    this.handleRetry()
  },
  handleSubmit() {
    if (this.data.saving) return
    this.setData({ saving: true })
    return this.applyViewModelResult(this.viewModel.submit(this.data)).finally(() => { if (!this._pageUnloaded) this.setData({ saving: false }) })
  },
  applyViewModelResult(result) {
    if (result && typeof result.then === 'function') {
      const epoch = this.feedbackEpoch, model = this.viewModel
      return result.then(value => { if (this.feedbackActive && this.feedbackEpoch === epoch && this.viewModel === model) this.applyViewModelResult(model.isCurrent() ? value : { data: model.projectRemote() }) })
    }
    if (!result) return
    if (result.data) this.setData(result.data, () => {
      if (Object.prototype.hasOwnProperty.call(result.data, 'items')) this.observeReplies()
    })
    if (result.command && result.command.type === 'toast') wx.showToast({ title: result.command.title, icon: 'none' })
    if (result.command && result.command.type === 'submitted') {
      wx.showToast({ title: '已提交', icon: 'success' })
      this.setData({ page: 1 })
      this.handleRetry()
    }
  }
}))
