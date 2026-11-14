const assert = require('node:assert/strict')
const { autorun } = require('mobx-miniprogram')
const api = require('../miniprogram/repositories/api-transport.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const { FeedbackViewModel } = require('../miniprogram/viewmodels/feedback-viewmodel.js')
const { MyViewModel } = require('../miniprogram/viewmodels/my-viewmodel.js')
const { createFeedbackRepository } = require('../miniprogram/repositories/feedback-repository.js')
const values = {}
const storage = { get: key => values[key], set: (key, value) => { values[key] = value }, remove: key => { delete values[key] } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function login(id) { auth.saveAuth(storage, { provider: 'email', userId: id, token: 'token-' + id, email: id + '@example.test' }) }
const rows = Array.from({ length: 25 }, (_, index) => ({ id: 'reply-' + index, version: 2, unread: true, response: index ? '管理员回复' : '很长的回复\n'.repeat(100), body: '问题', status: 'IN_PROGRESS' }))

async function run() {
  login('a'); remote.enable(true)
  let summary = { questionUnreadCount: 25, courseRequestUnreadCount: 1 }, finish, calls = 0
  api.request = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  const first = remote.refreshFeedbackSummary(storage), second = remote.refreshFeedbackSummary(storage)
  await tick(); assert.equal(calls, 1, '并发摘要请求合并')
  finish({ ok: true, data: summary }); await Promise.all([first, second])
  const my = new MyViewModel({ storage })
  const feedback = new FeedbackViewModel({ storage })
  let linked
  const stop = autorun(() => { linked = [my.load().data.learnRows.find(row => row.key === 'feedback').unread, feedback.projectRemote()] })
  assert.equal(linked[0], true); assert.deepEqual(linked[1], { questionUnread: true, courseUnread: true })
  api.request = async () => ({ ok: false, reason: '离线' })
  await assert.rejects(remote.refreshFeedbackSummary(storage), /离线/)
  assert.deepEqual(remote.getFeedbackSummary(storage), summary, '失败保留上次成功摘要')

  const requests = []
  let failRead = true
  const repository = createFeedbackRepository(storage, { request: async (...args) => {
    requests.push(args)
    return failRead ? { ok: false, reason: '超时' } : { ok: true, data: { acknowledgedCount: args[2].items.length } }
  } })
  await assert.rejects(repository.acknowledge('question', [rows[0]]), /超时/)
  failRead = false; summary = { questionUnreadCount: 24, courseRequestUnreadCount: 1 }
  api.request = async () => ({ ok: true, data: summary })
  await repository.acknowledge('question', [rows[0]]); await tick()
  assert.equal(requests[0][3].idempotencyKey, requests[1][3].idempotencyKey)
  assert.deepEqual(requests[1][2], { items: [{ id: 'reply-0', version: 2 }] })
  assert.equal(requests[1][1], '/me/question-feedback/read')
  assert.equal(linked[0], true, '其他分类仍未读时入口保留红点')

  let resolveOldSummary
  api.request = () => new Promise(resolve => { resolveOldSummary = resolve })
  const staleSummary = remote.refreshFeedbackSummary(storage)
  await tick()
  remote.invalidateFeedbackSummary(storage)
  summary = { questionUnreadCount: 0, courseRequestUnreadCount: 0 }
  api.request = async () => ({ ok: true, data: summary })
  await remote.refreshFeedbackSummary(storage)
  resolveOldSummary({ ok: true, data: { questionUnreadCount: 25, courseRequestUnreadCount: 1 } }); await staleSummary
  assert.equal(linked[0], false, '迟到摘要不能恢复已清除的红点')

  let resolveRead
  const model = new FeedbackViewModel({ storage, repository: {
    list: async (kind, page) => ({ items: rows.slice((page - 1) * 20, page * 20), total: 25, page, pageSize: 20 }),
    acknowledge: () => new Promise(resolve => { resolveRead = resolve })
  } })
  assert.equal((await model.list(1)).data.hasMore, true)
  const oldRead = model.acknowledge([rows[0]])
  await model.list(2)
  resolveRead({ acknowledgedCount: 1 }); assert.equal(await oldRead, null, '翻页后旧确认不得修改新页')
  assert.equal(model.items.length, 5); assert(model.items.every(row => row.unread))
  const late = remote.refreshFeedbackSummary(storage); login('b'); await late
  assert.deepEqual(remote.getFeedbackSummary(storage), { questionUnreadCount: 0, courseRequestUnreadCount: 0 })
  assert.deepEqual(feedback.projectRemote().items, [], '身份变化立即清空反馈视图')
  await assert.rejects(repository.acknowledge('course', [rows[0]]), /登录/)
  stop()

  await checkPage()
  remote.enable(false)
  console.log('feedback unread: shared badges, retry, observed versions, visibility, paging and identity isolation passed')
}

async function checkPage() {
  login('page')
  api.request = async () => ({ ok: true, data: { questionUnreadCount: 25, courseRequestUnreadCount: 1 } })
  const observers = [], acknowledged = []
  let definition, listFinish, readFinish, failRead = false, footer = null
  global.Page = value => { definition = value }
  global.wx = { getStorageSync: storage.get, setStorageSync: storage.set, getWindowInfo: () => ({ windowHeight: 800 }), showToast() {} }
  const filename = require.resolve('../miniprogram/page/feedback/index.js')
  delete require.cache[filename]; require(filename)
  const page = Object.assign({}, definition, {
    data: structuredClone(definition.data),
    setData(patch, done) {
      for (const [key, value] of Object.entries(patch)) {
        const nested = key.match(/^items\[(\d+)\]\.unread$/)
        if (nested) this.data.items[Number(nested[1])].unread = value
        else this.data[key] = value
      }
      if (done) done()
    },
    createSelectorQuery() { return { select() { return this }, boundingClientRect() { return this }, exec(done) { done([footer]) } } },
    createIntersectionObserver(options) {
      const observer = { options, disconnected: false, relativeTo(selector) { this.region = selector; return this }, relativeToViewport(margins) { this.margins = margins; return this }, observe(selector, callback) { this.callback = callback }, disconnect() { this.disconnected = true } }
      observers.push(observer); return observer
    }
  })
  page.onLoad({})
  page.viewModel = new FeedbackViewModel({ storage, repository: {
    list: (kind, number) => new Promise(resolve => { listFinish = () => resolve({ items: rows.slice((number - 1) * 20, number * 20).map(row => ({ ...row })), total: 25, page: number, pageSize: 20 }) }),
    acknowledge: (kind, items, shouldSend) => {
      assert(shouldSend())
      acknowledged.push([kind, items])
      return failRead ? Promise.reject(new Error('离线')) : new Promise(resolve => { readFinish = resolve })
    }
  } })
  const show = page.onShow(); page.onReady(); listFinish(); await show
  assert.equal(page.data.items.length, 20, 'onReady 不得使在途首屏列表失效')
  let observer = observers.at(-1)
  assert.equal(observer.region, '.feedback-page', '页头不属于回复可视参照区域')
  const expose = (source, index, ratio = 0.01) => source.callback({ intersectionRatio: ratio, dataset: { id: rows[index].id, version: 2 } })
  expose(observer, 0, 0); assert.equal(page.readQueue.size, 0, '屏幕外回复不确认')
  expose(observer, 0); expose(observer, 1); expose(observer, 20)
  const reading = page.flushReads()
  assert.deepEqual(acknowledged[0][1].map(item => item.id), ['reply-0', 'reply-1'], '同一批只含实际可见且属于当前页的回复，长回复部分可见即可')
  readFinish({ acknowledgedCount: 2 }); await reading
  assert.equal(page.data.items[0].unread, false); assert.equal(page.data.items[2].unread, true)
  page.onHide(); assert(observer.disconnected)
  expose(observer, 2); assert.equal(page.readQueue.size, 0)

  const resume = page.onShow(); listFinish(); await resume
  observer = observers.at(-1); failRead = true
  expose(observer, 2); await page.flushReads(); assert.equal(page.data.items[2].unread, true, '确认失败保留未读')
  failRead = false
  expose(observer, 3); const pending = page.flushReads()
  page.handleKind({ currentTarget: { dataset: { kind: 'course' } } }); footer = { top: 690 }; listFinish(); await tick()
  readFinish({ acknowledgedCount: 1 }); await pending
  assert.equal(page.data.items[3].unread, true, '切分类后迟到确认不修改新分类记录')
  assert.equal(observers.at(-1).margins.bottom, -110, '固定底部按钮遮挡区域不计已读')
  const oldObserver = observers.at(-1)
  page.handlePage({ currentTarget: { dataset: { step: 1 } } }); listFinish(); await tick()
  assert(oldObserver.disconnected); assert.equal(page.data.items.length, 5)
  expose(oldObserver, 0); assert.equal(page.readQueue.size, 0, '翻页后旧观察回调无效')
  const lastObserver = observers.at(-1)
  login('other'); expose(lastObserver, 20); assert.equal(page.readQueue.size, 0, '账号切换后不再确认旧账号回复')
  page.applyViewModelResult({ data: page.viewModel.projectRemote() }); assert.equal(page.data.items.length, 0)
  page.onUnload()
  delete global.Page; delete global.wx
}
run().catch(error => { console.error(error); process.exitCode = 1 })
