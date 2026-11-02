const { createWxStorageAdapter } = require('./utils/wx-storage.js')
const practiceRepository = require('./repositories/practice-repository.js')
const authRepository = require('./repositories/auth-repository.js')
const http = require('./repositories/http-gateway.js')
const onlinePractice = require('./repositories/online-practice.js')
const remoteData = require('./repositories/remote-data-repository.js')
const localConfig = require('./runtime.local.js')
const { createHeartbeat } = require('./repositories/activity-heartbeat.js')

App({
  globalData: {
    version: '1.0.0',
    // 题库是 tabBar 页面，而 switchTab 不支持 query 参数，
    // 因此首页点科目时先把 subjectId 暂存在这里，由题库页 onShow 时取走。
    pendingSubjectId: ''
  },

  onLaunch() {
    this.globalData.launchAt = Date.now()
    const storage = createWxStorageAdapter()
    this.activityHeartbeat = createHeartbeat({ getAuth: () => practiceRepository.getAuth(storage) })
    const config = Object.assign({}, localConfig, typeof wx.getExtConfigSync === 'function' ? wx.getExtConfigSync() || {} : {})
    http.configure({ baseUrl: config.apiBaseUrl || '', tokenProvider: () => practiceRepository.getAuth(storage).token || '',
      onUnauthorized: token => {
        if (!authRepository.expireAuth(storage, token)) return
        remoteData.bind(storage)
        const runtime = onlinePractice.current()
        if (runtime) runtime.identity()
        wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' })
      }
    })
    remoteData.enable(true)
    remoteData.bind(storage)
    onlinePractice.enable(storage)
    // 点击链路诊断的起点：逻辑层只要启动了，第一行日志就一定会有。
    // 如果控制台连这行都没有，说明 appservice 根本没跑起来，
    // 后面所有的「点了没反应」都不用再从业务代码里找。
    console.log('[trace] app onLaunch，逻辑层已启动')
  },

  onShow() {
    this.appVisible = true
    this.syncActivityHeartbeat()
    this.lifecycleEpoch = (this.lifecycleEpoch || 0) + 1
    const runtime = onlinePractice.current()
    if (!runtime) return
    try { runtime.identity(); runtime.queue.flushAll().catch(() => {}); runtime.flushViewClosures().catch(() => {}) } catch (error) { /* 登录后恢复同步 */ }
  },

  onHide() {
    this.appVisible = false
    if (this.activityHeartbeat) this.activityHeartbeat.stop()
    const runtime = onlinePractice.current()
    if (runtime && runtime.queue) runtime.queue.flushAll().catch(() => {})
  },

  syncActivityHeartbeat() {
    if (this.appVisible && this.activityHeartbeat) this.activityHeartbeat.start()
  },


  /**
   * 全局错误兜底：页面里抛的错会在这里以 `[trace] 未捕获` 打出来。
   * 之前排查「点不动」时控制台干干净净，就是因为没有这一层，
   * 分不清「没触发」和「触发了但内部报错被吞掉」。
   */
  onError(error) {
    console.error(`[trace] 未捕获错误：${error}`)
  },

  onUnhandledRejection(res) {
    console.error(`[trace] 未处理的 Promise 拒绝：${res && res.reason ? res.reason : res}`)
  },

  getLoadingMetrics() {
    return require('./utils/loading-metrics.js').snapshot()
  },

  setPendingSubjectId(subjectId) {
    this.globalData.pendingSubjectId = subjectId || ''
  },

  /** 取走即清空，避免下次普通切换 tab 时被重复消费 */
  consumePendingSubjectId() {
    const subjectId = this.globalData.pendingSubjectId || ''

    this.globalData.pendingSubjectId = ''

    return subjectId
  }
})
