const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { BankDetailViewModel } = require('../../viewmodels/bank-detail-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const filters = require('../../repositories/catalog-filters.js')
const remote = require('../../repositories/remote-data-repository.js')

Page(withPageLifecycle({
  customHeader: true,
  data: Object.assign(BankDetailViewModel.getInitialData(), {
    hasRecentPractice: false,
    filterColleges: [{ id: '', name: '全部学院' }], filterMajors: [{ id: '', name: '全部专业' }],
    filterGrades: filters.GRADES, filterCollegeIndex: 0, filterMajorIndex: 0, filterGradeIndex: 0, filterError: ''
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
    this.showSavedFilters(filters.read(this.viewModel.storage))
    this.loadFilters()
    this.refreshRecentVisibility()
    return this.refreshCatalog()
  },

  async refreshRecentVisibility() {
    const { repository, storage } = this.viewModel
    const auth = repository.getAuth(storage)
    const request = this.recentRequest = (this.recentRequest || 0) + 1
    try {
      this.setData({ hasRecentPractice: repository.getRemoteRecent(storage).length > 0 })
      if (!auth.loggedIn) return
      const recent = await repository.refreshRemote(storage, 'recent', { force: true })
      if (recent && !this._pageUnloaded && request === this.recentRequest && repository.getAuth(storage).token === auth.token) {
        this.setData({ hasRecentPractice: recent.items.length > 0 })
      }
    } catch (_) { /* Keep known history visible when the network is unavailable. */ }
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
    return this.viewModel.refreshRemote(subjectId, options).then(async result => {
      if (request !== this.catalogRequest || this._pageUnloaded) return
      this.applyViewModelResult(result)
      if (result && result.data && !result.data.catalogError) this.routeSubjectId = result.data.subjectId || ''
      const keyword = this.data.searchKeyword
      if (keyword && keyword.trim()) {
        try { this.applyViewModelResult(await this.viewModel.updateSearch(keyword)) }
        catch (error) { if (request === this.catalogRequest && this.data.searchKeyword === keyword) this.setData({ searchEmptyText: error.message }) }
      }
      if (request !== this.catalogRequest) return
      const pending = await this.viewModel.restorePendingPractice()
      if (request === this.catalogRequest) this.applyViewModelResult(pending)
    })
  },

  showSavedFilters(value) {
    const options = (rows, id, label) => id && !rows.some(row => row.id === id) ? rows.concat({ id, name: label }) : rows
    const stored = this.viewModel.storage.get(filters.KEY) || {}
    const colleges = options(this.data.filterColleges, value.collegeId, stored.collegeName || '已选学院')
    const majors = options(this.data.filterMajors, value.majorId, stored.majorName || '已选专业')
    this.setData({ filterColleges: colleges, filterMajors: majors,
      filterCollegeIndex: Math.max(0, colleges.findIndex(row => row.id === value.collegeId)),
      filterMajorIndex: Math.max(0, majors.findIndex(row => row.id === value.majorId)), filterGradeIndex: value.grade || 0 })
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
        this.viewModel.beginFilterRefresh()
        remote.setCatalogFilters(this.viewModel.storage, result.value, { clearPrevious: true })
        wx.showToast({ title: '已清理失效分类，请重新选择', icon: 'none' })
        return this.routeBankId ? this.refreshCatalog() : this.refreshFilteredCatalog()
      }
    } catch (error) {
      if (!this._pageUnloaded && request === this.filterRequest) this.setData({ filterError: error.message })
    }
  },

  changeFilters(patch) {
    try {
      this.viewModel.beginFilterRefresh()
      const value = remote.setCatalogFilters(this.viewModel.storage, patch)
      if (patch.collegeId !== undefined && !value.majorId) this.setData({ filterMajors: [this.data.filterMajors[0]] })
      this.showSavedFilters(value)
      this.loadFilters()
      return this.refreshFilteredCatalog()
    } catch (error) { this.viewModel.cancelFilterRefresh(); wx.showToast({ title: error.message || '筛选保存失败', icon: 'none' }) }
  },

  refreshFilteredCatalog() {
    clearTimeout(this.searchTimer)
    const keyword = this.data.searchKeyword || ''
    this.routeBankId = ''; this.routeSubjectId = ''; this.routeChapterId = ''
    this.viewModel.directBankId = ''
    const selected = this.data.subjectId
    this.viewModel.remotePage = 1
    this.viewModel.remoteSubjectPage = 1
    this.setData({ catalogSwitching: true })
    this.applyViewModelResult(this.viewModel.clearSearch())
    this.setData({ searchKeyword: keyword, searchLoading: !!keyword.trim(), searchActive: !!keyword.trim() })
    const request = this.catalogRequest = (this.catalogRequest || 0) + 1
    return this.viewModel.refreshRemote(selected, { force: true }).then(async result => {
      if (this._pageUnloaded || request !== this.catalogRequest) return
      this.applyViewModelResult(result)
      if (keyword.trim() && this.data.searchKeyword === keyword) this.applyViewModelResult(await this.viewModel.updateSearch(keyword))
    }).catch(error => {
      if (!this._pageUnloaded && request === this.catalogRequest) wx.showToast({ title: error.message || '筛选读取失败', icon: 'none' })
    }).finally(() => { if (!this._pageUnloaded && request === this.catalogRequest) this.setData({ searchLoading: false }) })
  },

  handleCollegeFilter(event) { const item = (this.data.filterColleges || [])[Number(event.detail.value)]; if (item) return this.changeFilters({ collegeId: item.id, collegeName: item.name }) },
  handleMajorFilter(event) { const item = (this.data.filterMajors || [])[Number(event.detail.value)]; if (item) return this.changeFilters({ majorId: item.id, majorName: item.name }) },
  handleGradeFilter(event) { return this.changeFilters({ grade: Number(event.detail.value) || null }) },

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
  handleCatalogErrorRetry() {
    return this.data.filterError ? Promise.all([this.loadFilters(), this.handleRetryLoad()]) : this.handleRetryLoad()
  },
  getRefreshError() { return this.data.catalogError || this.data.filterError || '' },
  onPullDownRefresh() { return Promise.all([this.loadFilters(), this.handleRetryLoad(), remote.refreshFeedbackSummary(this.viewModel.storage)]) },
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
  handleSheetFeedback(e) { this.applyViewModelResult(this.viewModel.setSheetFeedback(e.currentTarget.dataset.value)) },
  handleSheetOrder(e) { this.applyViewModelResult(this.viewModel.setSheetOrder(e.currentTarget.dataset.value)) },

  handlePresetSave() { this.applyViewModelResult(this.viewModel.saveSheetPreset()) },
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
