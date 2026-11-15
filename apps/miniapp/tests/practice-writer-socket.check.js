const assert = require('node:assert/strict')
const { createWriterSocket } = require('../miniprogram/repositories/practice-writer-socket.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const http = require('../miniprogram/repositories/http-gateway.js')

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
  const channel = createWriterSocket({ id: 'practice', deviceId: 'device', token: 'session-token', current: () => true, connect,
    binding: () => ({ writerToken: 'writer', epoch: 3 }), onEvent: event => events.push(event), random: () => 0,
    setTimeout(fn, delay) { const id = ++next; tasks.set(id, { fn, delay }); return id }, clearTimeout(id) { tasks.delete(id) } })
  sockets[0].handlers.open()
  assert.deepEqual(sockets[0].sent[0], { type: 'BIND', writerToken: 'writer', epoch: 3 })
  sockets[0].handlers.message({ data: JSON.stringify({ type: 'BOUND', leaseMillis: 40000 }) })
  assert.equal(tasks.size, 2)
  const deadline = [...tasks.values()].find(task => task.delay === 40000)
  deadline.fn()
  assert.equal(events.at(-1).type, 'DISCONNECTED', '无心跳确认时暂停，而不是继续离线作答')
  const retry = [...tasks.values()].find(task => task.delay === 500)
  retry.fn(); assert.equal(sockets.length, 2)
  sockets[0].handlers.message({ data: JSON.stringify({ type: 'BOUND' }) })
  assert.equal(events.at(-1).type, 'DISCONNECTED', '旧连接回调不能解锁新连接')
  channel.stop(); assert.equal(tasks.size, 0)

  const vm = new PracticeViewModel()
  let saved = 0, paused = 0, resumed = 0, archived = 0, stopped = 0
  vm.online = { deviceId: () => 'phone', archiveDraft() { archived++ }, save() { saved++ }, get: () => ({ status: 'IN_PROGRESS' }) }
  vm.session = { meta: { sessionId: 'practice' }, state: { isTimed: true }, pauseStudy() { paused++ }, resumeStudy() { resumed++ } }
  const lost = await vm.writerEvent({ type: 'DISCONNECTED' })
  assert(lost.stopTimer && lost.data.editingLocked); assert.equal(saved, 1); assert.equal(paused, 1)
  await vm.writerEvent({ type: 'PONG' }); assert.equal(resumed, 0, '心跳不越过恢复授权检查')
  const bound = await vm.writerEvent({ type: 'BOUND', state: { status: 'IN_PROGRESS', writer: { deviceId: 'phone' } } })
  assert(bound.startTimer && !bound.data.editingLocked); assert.equal(resumed, 1)
  vm.writerSocket = { stop() { stopped++ } }
  const taken = await vm.writerEvent({ type: 'WRITER_CHANGED' })
  assert.equal(taken.command.type, 'writerTakenOver'); assert.equal(archived, 1); assert.equal(stopped, 1)
  vm.detachedReview = true
  vm.online.assess = () => { throw new Error('草稿查看不应发送自评') }
  assert.equal(await vm.assessResult('question', 'CORRECT'), null)
  const values = new Map(), storage = { get: key => values.get(key), set: (key, value) => values.set(key, value), remove: key => values.delete(key), keys: () => [...values.keys()] }
  let respond
  const queue = require('../miniprogram/repositories/practice-sync-queue.js').createSyncQueue({ storage, userId: 'owner', setTimer: () => 1, clearTimer() {}, send: () => new Promise(resolve => { respond = resolve }) })
  queue.save('practice', { progress: { currentIndex: 0, items: [] } })
  const late = queue.flush('practice'); await Promise.resolve()
  const detached = queue.detach('practice'); assert(detached.pending, '隔离时保留原幂等请求')
  queue.seed('practice', 8); respond({ ok: true }); await late
  assert.equal(queue.get('practice').acknowledgedSequence, 8, '旧代次迟到回执不能改写新同步序号')
  queue.stop()
  console.log('答题连接超时、旧回调隔离、暂停计时与接管退出检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
