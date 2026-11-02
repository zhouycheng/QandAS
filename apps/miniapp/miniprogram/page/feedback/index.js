const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const { FeedbackViewModel } = require('../../viewmodels/feedback-viewmodel.js')
Page(withPageLifecycle({
  data: FeedbackViewModel.getInitialData(),
  onLoad(options) {
    this.viewModel = new FeedbackViewModel({ storage: createWxStorageAdapter() })
    this.applyViewModelResult(this.viewModel.load(options || {}))
    if (!this.data.compose) this.handleRetry()
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
    this.viewModel.kind = event.currentTarget.dataset.kind
    this.setData({ kind: this.viewModel.kind, items: [], page: 1, compose: false })
    this.handleRetry()
  },
  handleCompose() {
    this.setData({ compose: true, courseName: '', body: '' })
  },
  handleRetry() {
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
    if (result && typeof result.then === 'function') return result.then(value => this.applyViewModelResult(value))
    if (!result) return
    if (result.data) this.setData(result.data)
    if (result.command && result.command.type === 'toast') wx.showToast({ title: result.command.title, icon: 'none' })
    if (result.command && result.command.type === 'submitted') {
      wx.showToast({ title: '已提交', icon: 'success' })
      this.setData({ page: 1 })
      this.handleRetry()
    }
  }
}))
