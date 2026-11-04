const navigation = require('../../utils/navigation.js')
const { withPageLifecycle } = require('../../utils/page-lifecycle.js')
const { SubjectListViewModel } = require('../../viewmodels/subject-list-viewmodel.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
const { getInitialHomeHeaderData } = require('../../utils/home-header.js')

Page(withPageLifecycle({
  data: Object.assign(SubjectListViewModel.getInitialData(), getInitialHomeHeaderData()),

  isNavigating: false,

  hasLoadedOnce: false,

  onLoad() {
    if (wx.showShareMenu) wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    this.updateHeaderLayout()
    this.viewModel = new SubjectListViewModel({
      storage: createWxStorageAdapter()
    })
    this.refresh()
  },

  onResize() {
    this.updateHeaderLayout()
  },

  updateHeaderLayout() {
    const windowInfo = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : null
    const menuButton = typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null
    this.setData(getInitialHomeHeaderData(windowInfo, menuButton))
  },

  onShow() {
    this.isNavigating = false
    this.syncTabBar()

    // 从答题页返回时重新读取进度，保证统计实时
    if (this.hasLoadedOnce && this.viewModel) {
      this.refresh()
    }

    this.hasLoadedOnce = true
  },

  /**
   * 自定义 tabBar 不会自动跟随页面切换，必须由页面 onShow 主动同步选中态。
   * 不写这段的话：从首页跳到题库，底栏仍然高亮「首页」。
   */
  syncTabBar() {
    if (typeof this.getTabBar !== 'function') {
      return
    }

    const tabBar = this.getTabBar()

    if (tabBar && typeof tabBar.setSelected === 'function') {
      tabBar.setSelected('page/subject-list/index')
    }
  },

  noop() {},

  handleContinuePractice() { this.handleContinueTap() },

  onShareAppMessage() {
    return this.viewModel.getShareMessage()
  },
  onShareTimeline() { return { title: '题小搭 公开题库' } },

  // 下拉刷新
  onPullDownRefresh() {
    if (!this.viewModel) {
      wx.stopPullDownRefresh()
      return
    }

    return this.refresh({ force: true }).finally(() => wx.stopPullDownRefresh())
  },

  refresh(options) {
    this.applyViewModelResult({ data: this.viewModel.projectRemote() })
    return Promise.all([this.applyViewModelResult(this.viewModel.refreshRemote(options)), this.loadRecentChoices(options)])
  },

  async loadRecentChoices(options) {
    const revision = this.recentRevision = (this.recentRevision || 0) + 1
    this.setData({ recentLoading: true, recentError: '', recentSubjects: [], recentColumns: [[], []], recentSelectedSubjectId: '', recentSelectedBankId: '', recentSelectedName: '', recentHasHistory: false, newPracticeLoading: !!this.newPracticePending })
    try {
      const result = await this.viewModel.loadRecentChoices(options)
      if (revision !== this.recentRevision || !result) return
      const { subjects, hasHistory } = result
      const subject = subjects[0]
      const bank = subject && subject.banks[0]
      this.setData({ recentSubjects: subjects, recentColumns: [subjects.map(item => item.name), subject ? subject.banks.map(item => item.name) : []], recentPickerValue: [0, 0], recentSelectedSubjectId: subject ? subject.id : '', recentSelectedBankId: bank ? bank.id : '', recentSelectedName: bank ? subject.name + ' · ' + bank.name : '', recentHasHistory: hasHistory })
    } catch (error) {
      if (revision === this.recentRevision) this.setData({ recentError: error.message || '最近练习读取失败' })
    } finally {
      if (revision === this.recentRevision) this.setData({ recentLoading: false })
    }
  },

  handleRecentColumnChange(event) {
    const { column, value } = event.detail
    const selection = this.data.recentPickerValue.slice()
    selection[column] = value
    if (column === 0) selection[1] = 0
    const subject = this.data.recentSubjects[selection[0]]
    if (subject) this.setData({ recentPickerValue: selection, recentColumns: [this.data.recentSubjects.map(item => item.name), subject.banks.map(item => item.name)] })
  },

  handleRecentSelect(event) {
    const [subjectIndex, bankIndex] = event.detail.value
    const subject = this.data.recentSubjects[subjectIndex]
    const bank = subject && subject.banks[bankIndex]
    if (bank) this.setData({ recentPickerValue: [subjectIndex, bankIndex], recentSelectedSubjectId: subject.id, recentSelectedBankId: bank.id, recentSelectedName: subject.name + ' · ' + bank.name })
  },

  handleRecentCancel() {
    const subjectIndex = this.data.recentSubjects.findIndex(item => item.id === this.data.recentSelectedSubjectId)
    const subject = this.data.recentSubjects[subjectIndex]
    if (subject) this.setData({ recentPickerValue: [subjectIndex, Math.max(0, subject.banks.findIndex(item => item.id === this.data.recentSelectedBankId))], recentColumns: [this.data.recentSubjects.map(item => item.name), subject.banks.map(item => item.name)] })
  },

  handleRecentRetry() { return this.loadRecentChoices({ force: true }) },

  async handleNewPractice() {
    if (this.data.recentLoading || this.data.recentError || this.newPracticePending) return
    const subjects = this.data.recentSubjects
    const subject = subjects.find(item => item.id === this.data.recentSelectedSubjectId)
    const choice = subject && subject.banks.find(item => item.id === this.data.recentSelectedBankId)
    if (subjects.length && !choice) return
    const revision = this.recentRevision
    this.newPracticePending = true
    this.setData({ newPracticeLoading: true })
    try {
      const result = await this.viewModel.openNewPractice(choice)
      if (revision === this.recentRevision) this.applyViewModelResult(result)
    } catch (error) {
      if (revision === this.recentRevision) wx.showToast({ title: error.message || '无法开始答题，请重试', icon: 'none' })
    } finally {
      this.newPracticePending = false
      if (!this._pageUnloaded) this.setData({ newPracticeLoading: false })
    }
  },

  handleContinueTap() {
    const lastPractice = this.viewModel.buildResumablePractice()

    if (!lastPractice) {
      wx.showToast({ title: '暂无可继续的练习', icon: 'none' })
      this.applyViewModelResult({ data: this.viewModel.projectRemote() })
      return
    }

    this.applyViewModelResult(this.viewModel.openPractice(lastPractice.url, lastPractice.title))
  },

  // ---------- 倒计时卡 ----------

  /**
   * ViewModel 根据当前身份决定进入登录页或独立倒计时页。
   * 两种情况都走同一个入口，不因为状态不同而分成「看详情」和「去设置」两条路。
   */
  handleExamTap() {
    this.applyViewModelResult(this.viewModel.openExamSettings())
  },

  // ---------- 我的学习空间 ----------

  handleEntryTap(e) {
    const key = e.currentTarget.dataset.key

    if (!key) {
      return
    }

    this.applyViewModelResult(this.viewModel.openEntry(key))
  },

  // ---------- 搜索 ----------

  handleOpenSearch() {
    if (this.data.searchVisible) {
      return
    }

    this.applyViewModelResult(this.viewModel.openSearch())
  },

  /**
   * 输入即搜。放到 bindinput 而不是 bindconfirm：
   * 题库只有 200 多题，每次击键全表扫描也就几毫秒，
   * 但体验上「边打边看到结果」比「打完再按回车」好得多。
   * （对比：题库导入页的 textarea 必须放 bindblur，那里解析的是整张表。）
   */
  handleSearchInput(e) {
    this.runSearch(e.detail.value, 300)
  },

  handleSearchConfirm(e) {
    this.runSearch(e.detail.value, 0)
  },

  runSearch(keyword, delay) {
    if (!this.viewModel.repository.isRemoteEnabled || !this.viewModel.repository.isRemoteEnabled()) return this.applyViewModelResult(this.viewModel.searchQuestions(keyword))
    if (this.searchTimer) clearTimeout(this.searchTimer)
    const revision = (this.searchRevision || 0) + 1
    this.searchRevision = revision
    const execute = () => {
      this.setData({ searchLoading: true })
      Promise.resolve(this.viewModel.searchQuestions(keyword)).then((result) => {
        if (this.searchRevision === revision) this.applyViewModelResult(result)
      }).catch((error) => {
        if (this.searchRevision === revision) wx.showToast({ title: error.message, icon: 'none' })
      }).finally(() => { if (this.searchRevision === revision) this.setData({ searchLoading: false }) })
    }
    if (delay) this.searchTimer = setTimeout(execute, delay)
    else execute()
  },

  handleSearchMore() {
    if (this.data.searchLoading) return
    this.setData({ searchLoading: true })
    const revision = this.searchRevision
    Promise.resolve(this.viewModel.loadMoreSearch()).then((result) => {
      if (this.searchRevision === revision) this.applyViewModelResult(result)
    }).catch((error) => wx.showToast({ title: error.message, icon: 'none' })).finally(() => { if (this.searchRevision === revision) this.setData({ searchLoading: false }) })
  },

  handleSearchClose() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchRevision = (this.searchRevision || 0) + 1
    this.setData({ searchLoading: false })
    this.applyViewModelResult(this.viewModel.closeSearch())
  },

  onHide() {
    this.recentRevision = (this.recentRevision || 0) + 1
    this.setData({ newPracticeLoading: false })
  },

  onUnload() {
    this.recentRevision = (this.recentRevision || 0) + 1
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchRevision = (this.searchRevision || 0) + 1
  },

  handleSearchResultTap(e) {
    const questionId = e.currentTarget.dataset.id
    const item = (this.data.searchResults || []).find(result => result.id === questionId)

    if (!questionId) {
      return
    }

    // 先进面板再跳转：面板是 fixed 定位，跳页后仍留在这个 tab 的 DOM 里
    this.applyViewModelResult(this.viewModel.closeSearch())
    if (item && item.kind !== 'QUESTION') {
      this.handleViewModelCommand({ type: 'switchTab', url: '/page/bank-detail/index', target: {
        subjectId: item.subjectId, bankId: item.questionBankId, chapterId: item.chapterId || ''
      } })
      return
    }
    this.applyViewModelResult(this.viewModel.openSearchResult(questionId))
  },

  // ---------- 公告（小喇叭） ----------

  handleAnnouncementTap() {
    this.applyViewModelResult(this.viewModel.openAnnouncement())
    this.setData({ announcementLoading: true, announcementError: '' })
    return this.viewModel.loadAnnouncements(1).then(result => this.applyViewModelResult(result))
      .catch(error => this.setData({ announcementError: error.message }))
      .finally(() => this.setData({ announcementLoading: false }))
  },

  handleAnnouncementMore() {
    if (this.data.announcementLoading) return
    this.setData({ announcementLoading: true })
    return this.viewModel.loadAnnouncements((this.data.announcementPage || 1) + 1).then(result => this.applyViewModelResult(result))
      .catch(error => this.setData({ announcementError: error.message }))
      .finally(() => this.setData({ announcementLoading: false }))
  },

  handleRetryLoad() { return this.refresh({ force: true }) },

  handleAnnouncementClose() {
    this.applyViewModelResult(this.viewModel.closeAnnouncement())
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

  choosePractice(command, offset) {
    const start = offset || 0
    const page = command.choices.slice(start, start + 5)
    const hasNavigation = command.choices.length > 5
    wx.showActionSheet({
      itemList: page.map(item => item.label).concat(hasNavigation ? [start + 5 < command.choices.length ? '更多练习' : '返回第一组'] : []),
      success: result => {
        if (result.tapIndex === page.length) return this.choosePractice(command, start + 5 < command.choices.length ? start + 5 : 0)
        const selected = page[result.tapIndex]
        if (selected) this.applyViewModelResult(this.viewModel.openPractice(`/page/practice/index?sessionId=${encodeURIComponent(selected.id)}`, selected.label))
      }
    })
  },

  handleViewModelCommand(command) {
    if (command.type === 'choosePractice') return this.choosePractice(command, 0)

    if (command.type === 'toast') {
      wx.showToast({
        title: command.title || '操作失败',
        icon: 'none'
      })
      return
    }

    if (command.type === 'openRouteWithLoading') {
      this.openRouteWithLoading(command.payload)
      return
    }

    if (command.type === 'switchTab') {
      const app = getApp()
      if (command.target && app && app.setPendingBankTarget) app.setPendingBankTarget(command.target)
      else if (command.subjectId && app && app.setPendingSubjectId) app.setPendingSubjectId(command.subjectId)
      navigation.switchTab({
        url: command.url,
        fail: () => {
          if (command.target && app && app.setPendingBankTarget) app.setPendingBankTarget(null)
          if (command.subjectId && app && app.setPendingSubjectId) app.setPendingSubjectId('')
          wx.showToast({
            title: '页面暂不可用',
            icon: 'none'
          })
        }
      })
    }
  },

  openRouteWithLoading(payload) {
    const detail = payload || {}
    return navigation.navigateTo({ url: detail.url })
  }
}))
