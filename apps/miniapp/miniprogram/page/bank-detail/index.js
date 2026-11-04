const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { BankDetailViewModel } = require('../../viewmodels/bank-detail-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const filters = require('../../repositories/catalog-filters.js')
const remote = require('../../repositories/remote-data-repository.js')

Page(withPageLifecycle({
  customHeader: true,
  data: Object.assign(BankDetailViewModel.getInitialData(), {
    filterColleges: [{ id: '', name: '全部学院' }], filterMajors: [{ id: '', name: '全部专业' }],
    filterGrades: filters.GRADES, filterCollegeIndex: 0, filterMajorIndex: 0, filterGradeIndex: 0, filterError: '',
    filterToggleEnabled: false, filterToggleRestore: false
  }),

  isOpeningPractice: false,

  hasLoadedOnce: false,

  onLoad(options) {
    if (wx.showShareMenu) wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    this.routeSubjectId = options && options.subjectId || ''
    this.routeBankId = options && options.bankId || ''
    this.routeChapterId = options && options.chapterId || ''
    this.viewModel = new BankDetailViewModel({
      storage: createWxStorageAdapter()
    })
  },

  onShow() {
    this.isOpeningPractice = false
    this.syncTabBar()
    const app = getApp()
    const target = app && app.consumePendingBankTarget ? app.consumePendingBankTarget()
      : { subjectId: app && app.consumePendingSubjectId ? app.consumePendingSubjectId() : '' }
    if (target.intent === 'test') { this.viewModel.mockSelection = true; this.setData({ mockSelection: true }) }
    if (target.subjectId || target.bankId) {
      this.routeSubjectId = target.subjectId || ''
      this.routeBankId = target.bankId || ''
      this.routeChapterId = target.chapterId || ''
      this.chapterLocated = false
      this.viewModel.directBankId = ''
    }
    this.syncFilterToggle()
    this.loadFilters()
    return this.refreshCatalog()
  },

  syncTabBar() {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tabBar && tabBar.setSelected) tabBar.setSelected('page/bank-detail/index')
  },

  refreshCatalog(options) {
    const request = this.catalogRequest = (this.catalogRequest || 0) + 1
    if (this.routeBankId) {
      this.setData({ catalogLoading: true, catalogError: '' })
      const bankId = this.routeBankId
      const pending = this.viewModel.openPublicBank(bankId, options).then(async result => {
        if (this._pageUnloaded || request !== this.catalogRequest) return
        this.applyViewModelResult(result)
        if (this.routeChapterId && !this.chapterLocated) {
          this.chapterLocated = true
          this.applyViewModelResult(await this.viewModel.openBankConfig(this.data.subjectId, this.routeBankId, this.routeChapterId))
        }
        if (request === this.catalogRequest) this.applyViewModelResult(await this.viewModel.restorePendingPractice())
      })
        .catch(error => { if (!this._pageUnloaded && request === this.catalogRequest) this.setData({ catalogLoading: false, catalogError: error.message, subject: null }) })
      this.hasLoadedOnce = true
      return pending
    }
    const subjectId = this.routeSubjectId || this.data.subjectId
    if (!this.hasLoadedOnce) this.applyViewModelResult(this.viewModel.load(subjectId))
    this.hasLoadedOnce = true
    return this.applyViewModelResult(this.viewModel.refreshRemote(subjectId, options).then(result => {
      if (request !== this.catalogRequest) return
      this.applyViewModelResult(result)
      return this.viewModel.restorePendingPractice()
    }))
  },

  async loadFilters() {
    const request = this.filterRequest = (this.filterRequest || 0) + 1
    try {
      const result = await filters.options(this.viewModel.storage)
      if (this._pageUnloaded || request !== this.filterRequest) return
      this.setData({ filterColleges: result.colleges, filterMajors: result.majors, filterGrades: filters.GRADES,
        filterCollegeIndex: Math.max(0, result.colleges.findIndex(item => item.id === result.value.collegeId)),
        filterMajorIndex: Math.max(0, result.majors.findIndex(item => item.id === result.value.majorId)),
        filterGradeIndex: result.value.grade || 0, filterError: '' })
      if (result.invalid) {
        remote.setCatalogFilters(this.viewModel.storage, result.value, { clearPrevious: true })
        this.syncFilterToggle()
        wx.showToast({ title: '已清理失效分类，请重新选择', icon: 'none' })
        return this.routeBankId ? this.refreshCatalog() : this.refreshFilteredCatalog()
      }
      this.syncFilterToggle()
    } catch (error) {
      if (!this._pageUnloaded && request === this.filterRequest) this.setData({ filterError: error.message })
    }
  },

  changeFilters(patch) {
    try {
      const value = remote.setCatalogFilters(this.viewModel.storage, patch)
      this.setData({ filterGradeIndex: value.grade || 0 })
      this.syncFilterToggle()
      this.loadFilters()
      return this.refreshFilteredCatalog()
    } catch (error) { wx.showToast({ title: error.message || '筛选保存失败', icon: 'none' }) }
  },

  refreshFilteredCatalog() {
    clearTimeout(this.searchTimer)
    const keyword = this.data.searchKeyword || ''
    this.routeBankId = ''; this.routeSubjectId = ''; this.routeChapterId = ''
    this.viewModel.directBankId = ''
    this.viewModel.currentSubjectId = ''
    this.applyViewModelResult(this.viewModel.clearSearch())
    this.setData({ searchKeyword: keyword, searchLoading: !!keyword.trim(), searchActive: !!keyword.trim() })
    const request = this.catalogRequest = (this.catalogRequest || 0) + 1
    return this.viewModel.refreshRemote('', { force: true }).then(async result => {
      if (this._pageUnloaded || request !== this.catalogRequest) return
      this.applyViewModelResult(result)
      if (keyword.trim()) this.applyViewModelResult(await this.viewModel.updateSearch(keyword))
    }).catch(error => {
      if (!this._pageUnloaded && request === this.catalogRequest) wx.showToast({ title: error.message || '筛选读取失败', icon: 'none' })
    }).finally(() => { if (!this._pageUnloaded && request === this.catalogRequest) this.setData({ searchLoading: false }) })
  },

  handleCollegeFilter(event) { const item = (this.data.filterColleges || [])[Number(event.detail.value)]; if (item) return this.changeFilters({ collegeId: item.id }) },
  handleMajorFilter(event) { const item = (this.data.filterMajors || [])[Number(event.detail.value)]; if (item) return this.changeFilters({ majorId: item.id }) },
  handleGradeFilter(event) { return this.changeFilters({ grade: Number(event.detail.value) || null }) },

  syncFilterToggle() {
    try {
      const state = filters.toggleState(this.viewModel.storage)
      this.setData({ filterToggleEnabled: state.enabled, filterToggleRestore: state.restoring })
    } catch (error) { this.setData({ filterToggleEnabled: false, filterToggleRestore: false }) }
  },


  onShareAppMessage() {
    return this.viewModel.getShareMessage(this.data.subjectId, this.routeBankId)
  },

  onShareTimeline() { const share = this.onShareAppMessage(); return { title: share.title, query: (share.path.split('?')[1] || '') } },

  handleRecentTap() {
    this.routeBankId = ''; this.routeSubjectId = ''; this.viewModel.directBankId = ''
    this.applyViewModelResult(this.viewModel.enterRecent())
  },

  handleRequestCourse() {
    this.applyViewModelResult(this.viewModel.requestCourse())
  },

  handleSubjectSwitch(e) {
    const subjectId = e.currentTarget.dataset.subjectId

    if (!subjectId) {
      return
    }

    // 已经在看这个科目、且不是「最近在刷」状态时不需要重建
    if (subjectId === this.data.subjectId && this.data.railMode === 'subject') {
      return
    }

    this.routeBankId = ''; this.routeSubjectId = subjectId; this.viewModel.directBankId = ''
    this.applyViewModelResult(this.viewModel.switchSubject(subjectId))
    this.refreshCatalog()
  },

  handleBanksMore() { return this.applyViewModelResult(this.viewModel.loadMoreBanks()) },
  handleSubjectsMore() { return this.applyViewModelResult(this.viewModel.loadMoreSubjects()) },
  handleRetryLoad() { return this.refreshCatalog({ force: true }) },
  onPullDownRefresh() { return this.handleRetryLoad().finally(() => wx.stopPullDownRefresh()) },
  onHide() {
    this.viewModel.closeConfig()
    const pages = getCurrentPages()
    if (pages.length && pages[pages.length - 1].route !== 'page/bank-detail/index') { this.viewModel.mockSelection = false; this.setData({ mockSelection: false }) }
  },
  onUnload() { clearTimeout(this.searchTimer) },

  /**
   * 输入原文由页面保存，搜索结果按请求关键词更新，保持光标位置。
   */
  handleSearchInput(e) {
    if (this.viewModel.repository.isRemoteEnabled && this.viewModel.repository.isRemoteEnabled()) {
      clearTimeout(this.searchTimer)
      const keyword = e.detail.value
      this.viewModel.remoteSearchText = keyword.trim()
      this.setData({ searchKeyword: keyword, searchLoading: !!keyword.trim(), searchActive: !!keyword.trim() })
      this.searchTimer = setTimeout(() => {
        Promise.resolve(this.viewModel.updateSearch(keyword)).then(result => this.applyViewModelResult(result))
          .catch(error => { if (this.viewModel.remoteSearchText === keyword.trim()) this.setData({ searchEmptyText: error.message }) })
          .finally(() => { if (this.viewModel.remoteSearchText === keyword.trim()) this.setData({ searchLoading: false }) })
      }, 250)
      return
    }
    const result = this.viewModel.updateSearch(e.detail.value)

    if (!result || !result.data) {
      return
    }

    const data = Object.assign({}, result.data)
    delete data.searchKeyword
    this.setData(data)
  },

  handleSearchConfirm(e) {
    this.handleSearchInput(e)

    if (typeof wx.hideKeyboard === 'function') {
      wx.hideKeyboard({})
    }
  },

  handleSearchClear() {
    clearTimeout(this.searchTimer)
    this.setData({ searchKeyword: '' })
    this.applyViewModelResult(this.viewModel.clearSearch())
  },

  handleSearchMore() {
    if (this.data.searchLoading || !this.data.searchHasMore) return
    this.setData({ searchLoading: true })
    return this.applyViewModelResult(this.viewModel.updateSearch(this.viewModel.remoteSearchText, (this.viewModel.remoteSearchPage || 1) + 1))
      .finally(() => this.setData({ searchLoading: false }))
  },

  handleFilterToggle() {
    if (!this.data.filterToggleEnabled) return
    try {
      const value = remote.toggleCatalogFilters(this.viewModel.storage)
      if (!value) return
      this.setData({
        filterCollegeIndex: Math.max(0, this.data.filterColleges.findIndex(item => item.id === value.collegeId)),
        filterMajorIndex: Math.max(0, this.data.filterMajors.findIndex(item => item.id === value.majorId)),
        filterGradeIndex: value.grade || 0
      })
      this.syncFilterToggle()
      this.loadFilters()
      return this.refreshFilteredCatalog()
    } catch (error) { wx.showToast({ title: error.message || '筛选保存失败', icon: 'none' }) }
  },

  async openPracticeTarget(open, configure) {
    if (this.isOpeningPractice) return
    this.isOpeningPractice = true
    wx.showLoading({ title: '正在读取题目', mask: true })
    try {
      const result = await open()
      if (!result || !result.data || !this.viewModel.sheetTarget) return this.applyViewModelResult(result)
      if (configure && !this.viewModel.mockSelection) {
        this.applyViewModelResult(result)
        const pending = this.viewModel.refreshSheetScope()
        this.setData(this.viewModel.buildSheetData())
        this.applyViewModelResult(await pending)
      } else this.applyViewModelResult(await this.viewModel.confirmConfig())
    } catch (error) { wx.showToast({ title: error.message || '读取失败，请重试', icon: 'none' }) }
    finally { wx.hideLoading(); this.isOpeningPractice = false }
  },
  handleBankOpen(e) { const bank = e.detail.bank; return this.openPracticeTarget(() => this.viewModel.openBankConfig(this.data.subjectId, bank.bankId, bank.chapterId), false) },
  handleBankConfigure(e) { const bank = e.detail.bank; return this.openPracticeTarget(() => this.viewModel.openBankConfig(this.data.subjectId, bank.bankId, bank.chapterId), true) },
  handleSearchResultTap(e) { const d = e.currentTarget.dataset; return this.openPracticeTarget(() => this.viewModel.openBankConfig(d.subjectId, d.bankId, d.chapterId), false) },
  handleSearchConfigure(e) { const d = e.currentTarget.dataset; return this.openPracticeTarget(() => this.viewModel.openBankConfig(d.subjectId, d.bankId, d.chapterId), true) },
  handleStatTap() { return this.openPracticeTarget(() => this.viewModel.openSubjectConfig(this.data.subjectId), true) },
  handleExitMock() { this.viewModel.mockSelection = false; this.setData({ mockSelection: false }); this.handleSheetClose() },
  handleSheetCount(event) { this.applyViewModelResult(this.viewModel.setSheetCount(event.currentTarget.dataset.value === 'ALL' ? 'ALL' : Number(event.currentTarget.dataset.value))) },

  handleSheetBank(event) {
    this.applyViewModelResult(this.viewModel.setSheetBank(event.currentTarget.dataset.id))
    return this.refreshSheetScope()
  },

  handleSheetMode(e) {
    this.applyViewModelResult(this.viewModel.setSheetMode(e.currentTarget.dataset.value))
  },

  handleSheetPreset(e) { this.applyViewModelResult(this.viewModel.selectSheetPreset(Number(e.detail.value))) },
  handleCustomDuration(e) { this.applyViewModelResult(this.viewModel.setCustomDuration(e.detail.value)) },
  async refreshSheetScope() { const pending = this.viewModel.refreshSheetScope(); this.setData(this.viewModel.buildSheetData()); this.applyViewModelResult(await pending) },
  handleSheetDuration(e) {
    const value = e.currentTarget.dataset.value
    const result = this.viewModel.selectDuration(value)

    if (result) {
      this.applyViewModelResult(result)
    }
  },

  handleSheetOnlyWrong(e) {
    this.applyViewModelResult(this.viewModel.setSheetOnlyWrong(e.detail.value))
    return this.refreshSheetScope()
  },

  handleSheetClose() {
    this.applyViewModelResult(this.viewModel.closeConfig())
  },

  async handleConfigConfirm() {
    if (this.isOpeningPractice || this.data.sheetStartDisabled) return
    this.isOpeningPractice = true
    wx.showLoading({ title: '正在准备答题', mask: true })
    try { this.applyViewModelResult(await this.viewModel.confirmConfig(this.data)) }
    catch (error) { wx.showToast({ title: error.message || '开始失败，请重试', icon: 'none' }) }
    finally { wx.hideLoading(); this.isOpeningPractice = false }
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

    if (result.command) {
      this.handleViewModelCommand(result.command)
    }
  },

  handleViewModelCommand(command) {
    if (command.type === 'toast') {
      wx.showToast({
        title: command.title || '操作失败',
        icon: 'none'
      })
      return
    }

    if (command.type === 'openRouteWithLoading') {
      this.openRouteWithLoading(command.payload)
    }
  },

  openRouteWithLoading(payload) {
    const detail = payload || {}
    return navigation.navigateTo({ url: detail.url })
  }
}))
