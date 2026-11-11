const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const { PracticeRecordsViewModel } = require('../../viewmodels/practice-records-viewmodel.js')
const online = require('../../repositories/online-practice.js')
Page(withPageLifecycle({
  data: { items: [], loading: false, error: '', hasMore: false },
  onLoad() { this.viewModel = new PracticeRecordsViewModel(createWxStorageAdapter()) },
  onShow() {
    if (!this.viewModel) return
    const runtime = online.current()
    this.changed = () => { if (!this._pageUnloaded) this.setData({ items: this.viewModel.view() }) }
    if (runtime) { try { runtime.identity(); runtime.statusListeners.add(this.changed); runtime.queue.flushAll().catch(() => {}) } catch (_) { this.setData({ items: [], error: '请登录原账号后查看练习记录' }); return } }
    this.refresh(true)
  },
  onHide() { const runtime = online.current(); if (runtime) runtime.statusListeners.delete(this.changed) },
  onUnload() { this.onHide() },
  refresh(reset) {
    if (this.data.loading) return
    this.setData({ loading: true, items: this.viewModel.view() })
    return this.viewModel.load(reset).then(data => { if (!this._pageUnloaded) this.setData(data) }).finally(() => { if (!this._pageUnloaded) this.setData({ loading: false }) })
  },
  handleRetry() { return this.refresh(true) },
  onReachBottom() { if (this.data.hasMore) return this.refresh(false) },
  handleOpen(event) {
    const item = this.data.items.find(value => value.id === event.currentTarget.dataset.id)
    if (!item) return
    const command = this.viewModel.open(item)
    if (command.type === 'toast') wx.showToast({ title: command.title, icon: 'none' })
    else wx.navigateTo({ url: command.url })
  }
}))
