const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const { PracticePresetsViewModel } = require('../../viewmodels/practice-presets-viewmodel.js')
Page(withPageLifecycle({
  data: PracticePresetsViewModel.getInitialData(),
  onLoad() { this.viewModel = new PracticePresetsViewModel({ storage: createWxStorageAdapter() }) },
  onShow() { this.applyViewModelResult(this.viewModel.load()) },
  onHide() { this.applyViewModelResult(this.viewModel.cancel()) },
  handleEdit(e) { this.applyViewModelResult(this.viewModel.edit(e.currentTarget.dataset.id)) },
  handleInput(e) { this.viewModel.change(e.currentTarget.dataset.key, e.detail.value) },
  handleChoice(e) { this.applyViewModelResult(this.viewModel.change(e.currentTarget.dataset.key, e.currentTarget.dataset.value)) },
  handleDuration(e) {
    const value = e.currentTarget.dataset.value
    this.setData({ customDuration: value === 'custom' })
    if (value !== 'custom') this.applyViewModelResult(this.viewModel.change('duration', Number(value)))
  },
  handleSave() { this.applyViewModelResult(this.viewModel.save(this.data.customDuration)) },
  handleCancel() { this.applyViewModelResult(this.viewModel.cancel()) },
  handleDefault(e) { this.applyViewModelResult(this.viewModel.setDefault(e.currentTarget.dataset.id)) },
  handleDelete(e) { const id = e.currentTarget.dataset.id; wx.showModal({ title: '删除预设', content: '删除后不影响已开始的练习。', success: r => { if (r.confirm) this.applyViewModelResult(this.viewModel.remove(id)) } }) },
  applyViewModelResult(result) { if (!result) return; if (result.data) this.setData(result.data); if (result.command) wx.showToast({ title: result.command.title, icon: 'none' }) }
}))
