const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { QuestionDetailViewModel } = require('../../viewmodels/question-detail-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
Page(withPageLifecycle({
  data: QuestionDetailViewModel.getInitialData(),

  onLoad(options) {
    this.routeOptions = options || {}
    this.publicQuestionId = options && options.id || ''
    if (wx.showShareMenu) wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    this.viewModel = new QuestionDetailViewModel({
      storage: createWxStorageAdapter()
    })
    this.applyViewModelResult(this.viewModel.load(options))
    this.applyViewModelResult(this.viewModel.refreshRemote(options))
  },

  onHide() {
    if (this.viewModel) this.viewModel.release()
    require('../../repositories/remote-data-repository.js').releaseQuestion(this.publicQuestionId)
    this.setData(QuestionDetailViewModel.getInitialData()); this.reloadOnShow = true
  },
  onShow() { if (this.reloadOnShow && this.viewModel) { this.reloadOnShow = false; this.applyViewModelResult(this.viewModel.refreshRemote(this.routeOptions)) } },
  onUnload() { if (this.viewModel) this.viewModel.release(); require('../../repositories/remote-data-repository.js').releaseQuestion(this.publicQuestionId) },
  handleToggleFavorite() {
    this.applyViewModelResult(this.viewModel.toggleFavorite(this.data.questionId))
  },
  onShareAppMessage() { return { title: '题小搭 公开题目', path: this.publicQuestionId ? '/page/question-detail/index?id=' + encodeURIComponent(this.publicQuestionId) : '/page/subject-list/index' } },
  onShareTimeline() { return { title: '题小搭 公开题目', query: this.publicQuestionId ? 'id=' + encodeURIComponent(this.publicQuestionId) : '' } },

  handleFeedback() {
    this.applyViewModelResult(this.viewModel.openFeedback())
  },

  applyViewModelResult(result) {
    if (result && typeof result.then === 'function') {
      return result.then((value) => this.applyViewModelResult(value)).catch((error) => wx.showToast({ title: error.message || '请求失败', icon: 'none' }))
    }
    if (!result) {
      return
    }

    if (result.data) {
      this.setData(result.data)
    }
    if (result.command && result.command.type === 'navigate') require('../../utils/navigation.js').navigateTo(result.command.url)
  }
}))
