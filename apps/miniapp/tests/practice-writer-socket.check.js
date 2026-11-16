const assert = require('node:assert/strict')
const { createWriterSocket } = require('../miniprogram/repositories/practice-writer-socket.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const http = require('../miniprogram/repositories/http-gateway.js')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const { runInNewContext } = require('node:vm')

async function main() {
  const tasks = new Map(), events = [], sockets = []
  let next = 0
  http.configure({ baseUrl: 'https://example.test' })
  const connect = options => {
    assert.equal(options.header.Authorization, 'Bearer session-token')
    assert(!options.url.includes('session-token'))
    const handlers = {}, sent = []
    const socket = { handlers, sent, onOpen(fn) { handlers.open = fn }, onMessage(fn) { handlers.message = fn }, onClose(fn) { handlers.close = fn }, onError(fn) { handlers.error = fn }, send(value) { sent.push(JSON.parse(value.data)) }, close() { if (handlers.close) handlers.close() } }
    sockets.push(socket); return socket
  }
  const file = require.resolve('../miniprogram/repositories/online-practice.js')
  const loaded = { exports: {} }, imports = new Map(), requireLocal = createRequire(file)
  let defining = true
  runInNewContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})')(name => {
    if (defining) imports.set(name, requireLocal(name))
    assert(imports.has(name), '答题连接必须随仓储声明依赖，微信按需注入后不能临时加载未声明模块：' + name)
    return imports.get(name)
  }, loaded, loaded.exports)
  defining = false
  const watched = loaded.exports.OnlinePractice.prototype.watchWriter.call({
    identity: () => ({ userId: 'owner', token: 'session-token' }), deviceId: () => 'device',
    storage: { get: () => ({ provider: 'email', userId: 'owner', token: 'session-token' }) }, get: () => ({ writer: { epoch: 3, writerToken: 'writer' } })
  }, 'practice', connect, () => {})
  watched.stop(); sockets.length = 0
  const channel = createWriterSocket({ id: 'practice', deviceId: 'device', token: 'session-token', current: () => true, connect,
    binding: () => ({ writerToken: 'writer', epoch: 3 }), onEvent: event => events.push(event), random: () => 0,
    setTimeout(fn, delay) { const id = ++next; tasks.set(id, { fn, delay }); return id }, clearTimeout(id) { tasks.delete(id) } })
  sockets[0].handlers.open()
  assert.deepEqual(sockets[0].sent[0], { type: 'BIND', writerToken: 'writer', epoch: 3 })
  sockets[0].handlers.message({ data: JSON.stringify({ type: 'BOUND', leaseMillis: 40000 }) })
  assert.equal(tasks.size, 2)
  const deadline = [...tasks.values()].find(task => task.delay === 40000)
  deadline.fn()
  assert.equal(events.at(-1).type, 'DISCONNECTED', '无心跳确认时标记断开，由上层降级为本地作答')
  const retry = [...tasks.values()].find(task => task.delay === 500)
  retry.fn(); assert.equal(sockets.length, 2)
  sockets[0].handlers.message({ data: JSON.stringify({ type: 'BOUND' }) })
  assert.equal(events.at(-1).type, 'DISCONNECTED', '旧连接回调不能解锁新连接')
  channel.stop(); assert.equal(tasks.size, 0)

  const vm = new PracticeViewModel()
  let saved = 0, paused = 0, resumed = 0, archived = 0, stopped = 0
  vm.online = { deviceId: () => 'phone', archiveDraft() { archived++ }, save() { saved++ }, get: () => ({ status: 'IN_PROGRESS' }) }
  vm.session = { meta: { sessionId: 'practice' }, state: { isTimed: true }, pauseStudy() { paused++ }, resumeStudy() { resumed++ } }
  const disconnected = await vm.writerEvent({ type: 'DISCONNECTED' })
  assert.equal(disconnected, null, 'Socket 断开不再暂停本地答题'); assert.equal(saved, 0); assert.equal(paused, 0)
  await vm.writerEvent({ type: 'PONG' }); assert.equal(resumed, 0, '心跳不越过恢复授权检查')
  const bound = await vm.writerEvent({ type: 'BOUND', state: { status: 'IN_PROGRESS', writer: { deviceId: 'phone' } } })
  assert(bound.startTimer && !bound.data.editingLocked); assert.equal(resumed, 1)
  vm.writerSocket = { stop() { stopped++ } }
  const taken = await vm.writerEvent({ type: 'WRITER_CHANGED' })
  assert.equal(taken.command.type, 'writerTakenOver'); assert.equal(archived, 1); assert.equal(stopped, 1)
  vm.detachedReview = true
  vm.online.assess = () => { throw new Error('草稿查看不应发送自评') }
  assert.equal(await vm.assessResult('question', 'CORRECT'), null)
  vm.detachedReview = false; vm.readOnlyReview = false
  vm.releaseWriter = async () => ({ released: true })
  vm.online.writerState = async () => ({ writer: { deviceId: null } })
  vm.checkWriter = async () => ({ data: { editingLocked: true } })
  const expired = await vm.writerEvent({ type: 'DRAIN_WRITER' })
  assert.equal(expired.watchWriter, true, '已超时的接续恢复原端授权')
  assert.equal(expired.command, undefined, '无人接续时不显示已在其他设备继续')
  const values = new Map(), storage = { get: key => values.get(key), set: (key, value) => values.set(key, value), remove: key => values.delete(key), keys: () => [...values.keys()] }
  let respond
  const queue = require('../miniprogram/repositories/practice-sync-queue.js').createSyncQueue({ storage, userId: 'owner', setTimer: () => 1, clearTimer() {}, send: () => new Promise(resolve => { respond = resolve }) })
  queue.save('practice', { progress: { currentIndex: 0, items: [] } })
  const late = queue.flush('practice'); await Promise.resolve()
  const detached = queue.detach('practice'); assert(detached.pending, '隔离时保留原幂等请求')
  queue.seed('practice', 8); respond({ ok: true }); await late
  assert.equal(queue.get('practice').acknowledgedSequence, 8, '旧代次迟到回执不能改写新同步序号')
  queue.stop()
  let releaseResponse, current = { status: 'IN_PROGRESS', writer: { writerToken: 'old' }, releaseCommand: { key: 'release', body: { writerToken: 'old' } } }
  const releasing = require('../miniprogram/repositories/online-practice.js').OnlinePractice.prototype.releaseWriter.call({
    get: () => current, required: () => new Promise(resolve => { releaseResponse = resolve }), put: () => assert.fail('旧释放响应不能写入新快照')
  }, null, 'practice')
  current = { status: 'IN_PROGRESS', version: 9, writer: { writerToken: 'new', epoch: 4 } }
  releaseResponse({ version: 3 }); await releasing
  assert.equal(current.writer.writerToken, 'new'); assert.equal(current.version, 9, '迟到的释放响应不撤销重新接续后的授权')
  const claimValues = new Map([['qandaWriterClaim:owner:practice', { key: 'old-claim', body: { expectedEpoch: 1, deviceId: 'phone' } }]])
  const claimStorage = { get: key => claimValues.get(key), set: (key, value) => claimValues.set(key, value), remove: key => claimValues.delete(key) }
  await require('../miniprogram/repositories/online-practice.js').OnlinePractice.prototype.claimWriter.call({
    identity: () => ({ userId: 'owner' }), deviceId: () => 'phone', storage: claimStorage, required: async () => ({}), queue: { isIdle: () => true },
    writerState: async () => ({ status: 'IN_PROGRESS', writer: { deviceId: 'phone' }, transfer: { requestId: 'old-claim', state: 'READY' } }),
    fetchWriterSnapshot: async () => { claimStorage.set('qandaWriterClaim:owner:practice', { key: 'new-claim', body: { expectedEpoch: 3 } }); return {} }
  }, 'practice')
  assert.equal(claimStorage.get('qandaWriterClaim:owner:practice').key, 'new-claim', '旧申请的迟到结束不能清除下一次接续意图')
  console.log('答题连接超时、旧回调隔离、暂停计时与接管退出检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
