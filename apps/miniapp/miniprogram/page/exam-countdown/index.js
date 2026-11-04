const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const { ExamCountdownViewModel } = require('../../viewmodels/exam-countdown-viewmodel.js')
const { colors } = require('../../utils/design-tokens.js')
Page(withPageLifecycle({
  data: ExamCountdownViewModel.getInitialData(),
  onLoad() { this.viewModel = new ExamCountdownViewModel({ storage: createWxStorageAdapter() }) },
  onShow() { this.applyViewModelResult(this.viewModel.load()) },
  handleAddExam() { this.applyViewModelResult(this.viewModel.openEditor()) },
  handleEditExam(e) { this.applyViewModelResult(this.viewModel.openEditor(e.currentTarget.dataset.id)) },
  handleExamNameInput(e) { this.applyViewModelResult(this.viewModel.setDraftName(e.detail.value)) },
  handleExamDateChange(e) { this.applyViewModelResult(this.viewModel.setDraftDate(e.detail.value)) },
  handleCancelEdit() { this.applyViewModelResult(this.viewModel.closeEditor()) },
  handleSaveExam() { this.applyViewModelResult(this.viewModel.saveExam()) },
  handleDeleteExam(e) {
    const id = e.currentTarget.dataset.id
    const exam = this.data.exams.find(item => item.id === id)
    if (!exam) return
    wx.showModal({ title: '删除倒计时', content: '确定删除“' + exam.examName + '”吗？', confirmColor: colors.danger, success: result => { if (result.confirm) this.applyViewModelResult(this.viewModel.deleteExam(id)) } })
  },
  applyViewModelResult(result) {
    if (!result) return
    if (result.data) this.setData(result.data)
    if (result.command) wx.showToast({ title: result.command.title, icon: 'none' })
  }
}))
