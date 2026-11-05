const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const { stemPercentAt } = require('../../utils/practice-layout.js')
const { viewPatch } = require('../../models/view-patch.js')
const { PracticeLayoutViewModel } = require('../../viewmodels/practice-layout-viewmodel.js')
Page(withPageLifecycle({
  data: PracticeLayoutViewModel.getInitialData(),
  ignoreSwipe() {},
  onAnswerFocus() {},
  onAnswerBlur() {},
  onKeyboardHeight() {},
  onPaneScroll() {},
  onLoad() {
    this.viewModel = new PracticeLayoutViewModel({ storage: createWxStorageAdapter() })
    this.applyViewModelResult(this.viewModel.load())
  },
  onShow() { this.pageVisible = true; this.measure() },
  onReady() { this.measure() },
  onResize() { this.ratioAdjusting = false; this.cancelDrag(); this.measure() },
  onHide() { this.pageVisible = false; this.ratioAdjusting = false; this.cancelDrag() },
  onUnload() { clearInterval(this.edgeTimer) },
  measure() {
    if (this._pageUnloaded || this.pageVisible === false || typeof this.createSelectorQuery !== 'function') return
    const version = this.measureVersion = (this.measureVersion || 0) + 1
    const heights = Object.assign({}, this.data.paneHeights)
    const query = this.createSelectorQuery()
    query.select('#layout-scroll').boundingClientRect()
    query.selectAll('.layout-module').boundingClientRect()
    query.select('#layout-content').fields({ size: true, computedStyle: ['padding-top', 'padding-bottom'] })
    query.select('.layout-ratio-track').boundingClientRect()
    query.selectAll('.layout-module').fields({ computedStyle: ['margin-top', 'margin-bottom'] })
    query.exec(results => {
      if (this._pageUnloaded || this.pageVisible === false || version !== this.measureVersion || !results || !results[0]) return
      this.ratioTrack = results[3]
      this.viewport = results[0]
      this.blocks = results[1] || []
      this.scrollHeight = results[2] ? results[2].height : this.viewport.height
      this.measuredScroll = this.actualScroll || 0
      if (this.viewModel && this.viewModel.setHeight) {
        const margins = results[4] || []
        const fixed = this.blocks.reduce((sum, block, index) => sum + block.height - (['stem', 'response'].includes(block.dataset.module) ? heights[block.dataset.module] || 0 : 0)
          + (parseFloat((margins[index] || {})['margin-top']) || 0) + (parseFloat((margins[index] || {})['margin-bottom']) || 0), 0)
        const padding = (parseFloat((results[2] || {})['padding-top']) || 0) + (parseFloat((results[2] || {})['padding-bottom']) || 0)
        const available = Math.max(0, Math.floor(this.viewport.height - fixed - padding))
        if (available !== this.viewModel.height) {
          const patch = viewPatch(this.data, this.viewModel.setHeight(available).data)
          if (Object.keys(patch).length) this.setData(patch, () => this.measure())
        }
      }
    })
  },
  handleScroll(event) {
    this.actualScroll = event.detail.scrollTop
    this.scrollHeight = event.detail.scrollHeight
    if (this.drag) {
      this.setData({ dragScroll: this.actualScroll - this.drag.scroll })
      this.targetAt(this.drag.y)
    } else this.measure()
  },
  handleDragStart(event) {
    if (!this.blocks || !this.viewport) { this.measure(); return }
    this.drag = { id: event.id, y: event.y, scroll: this.actualScroll || 0, index: this.viewModel.order.indexOf(event.id) }
    this.setData({ dragId: event.id, dragTarget: '', dragScroll: 0 })
    clearInterval(this.edgeTimer)
    this.edgeTimer = setInterval(() => {
      if (!this.drag) return
      const y = this.drag.y
      const direction = y < this.viewport.top + 52 ? -1 : y > this.viewport.bottom - 52 ? 1 : 0
      if (!direction) return
      const max = Math.max(0, (this.scrollHeight || 0) - this.viewport.height)
      const next = Math.max(0, Math.min(max, (this.actualScroll || 0) + direction * 12))
      this.setData({ scrollTop: next })
    }, 32)
  },
  targetAt(y) {
    if (!this.drag) return
    const delta = (this.actualScroll || 0) - (this.measuredScroll || 0)
    const others = this.blocks.filter(block => block.dataset.module !== this.drag.id).sort((a, b) => a.top - b.top)
    const index = others.filter(block => y > (block.top + block.bottom) / 2 - delta).length
    this.drag.index = index
    const target = others[index] ? others[index].dataset.module : 'end'
    if (target !== this.data.dragTarget) this.setData({ dragTarget: target })
  },
  handleDragMove(event) { if (this.drag) { this.drag.y = event.y; this.targetAt(event.y) } },
  handleDragEnd(event) {
    if (!this.drag) return
    this.targetAt(event.y)
    const result = this.viewModel.drop(this.drag.id, this.drag.index)
    this.cancelDrag()
    this.applyViewModelResult(result)
  },
  handleDragCancel() { this.cancelDrag() },
  cancelDrag() {
    clearInterval(this.edgeTimer)
    this.drag = null
    if (!this._pageUnloaded) this.setData({ dragId: '', dragTarget: '', dragScroll: 0, dragReset: (this.data.dragReset || 0) + 1 }, () => this.measure())
  },
  setPanePercent(value) {
    if (value !== null && value !== this.data.stemPercent) this.applyViewModelResult(this.viewModel.setPercent(value))
  },
  updateRatioAt(y) {
    const rect = this.ratioTrack
    if (rect) this.setPanePercent(stemPercentAt(y, rect.top, rect.height))
  },
  handleRatioTouchStart(e) {
    if (e.touches.length !== 1) return
    this.cancelDrag()
    this.ratioAdjusting = true
    this.updateRatioAt(e.touches[0].clientY)
  },
  handleRatioTouchMove(e) {
    if (e.touches.length !== 1) { this.ratioAdjusting = false; return }
    if (this.ratioAdjusting) this.updateRatioAt(e.touches[0].clientY)
  },
  handleRatioTouchEnd(e) {
    if (this.ratioAdjusting && e.changedTouches.length === 1) this.updateRatioAt(e.changedTouches[0].clientY)
    this.ratioAdjusting = false
  },
  handleRatioTouchCancel() { this.ratioAdjusting = false },
  handleRatioStep(e) {
    const step = Number(e.currentTarget.dataset.step)
    if (step === 5 || step === -5) this.setPanePercent(Math.max(30, Math.min(70, this.data.stemPercent + step)))
  },
  handleResetLayout() { this.cancelDrag(); this.applyViewModelResult(this.viewModel.reset()) },
  handleSaveLayout() { this.cancelDrag(); this.applyViewModelResult(this.viewModel.save()) },
  applyViewModelResult(result) {
    if (result.data) this.setData(result.data, () => this.measure())
    if (result.command) wx.showToast({ title: result.command.title, icon: 'none' })
  },
  openFeedback() {}, selectOption() {}, inputAnswerText() {}, inputBlank() {}, assessShortAnswer() {}, toggleFavorite() {}, openOverview() {}, toggleMark() {}, goPrev() {}, goNext() {}
}))
