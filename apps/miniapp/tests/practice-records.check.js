const assert = require('assert')
const { summarize, openRecord } = require('../miniprogram/models/practice-record-summary.js')
const http = require('../miniprogram/repositories/http-gateway.js')
const { records, PracticeRecordsViewModel } = require('../miniprogram/viewmodels/practice-records-viewmodel.js')
const { createSyncQueue } = require('../miniprogram/repositories/practice-sync-queue.js')
async function main() {
  const list = records([{ id: 'one', status: 'IN_PROGRESS', createdAt: '2026-11-01' }, { id: 'two', status: 'SUBMITTED', createdAt: '2026-11-02' }], [{ id: 'one', finishIntent: true, createdAt: '2026-11-03', items: [{}, {}] }])
  assert.strictEqual(list.length, 2)
  assert.strictEqual(list[0].statusText, '练习记录恢复中')
  assert.strictEqual(list[0].countText, '2 题')
  assert.strictEqual(list[1].statusText, '已完成')
  assert.deepStrictEqual(openRecord({ id: 'pending', status: 'WAITING', feedback: 'AFTER_FINISH' }), { type: 'toast', title: '练习记录已保存在本机，正在恢复' })
  assert.strictEqual(openRecord({ id: 'pending', status: 'WAITING', feedback: 'IMMEDIATE' }).type, 'toast')
  assert.strictEqual(openRecord({ id: 'active', status: 'IN_PROGRESS' }).url, '/page/practice/index?sessionId=active')
  assert.strictEqual(summarize({ id: 'local', status: 'IN_PROGRESS', localState: { status: 'SUBMITTED' } }).status, 'WAITING')
  assert.strictEqual(records([{ id: 'done', status: 'SUBMITTED' }], [{ id: 'done', status: 'IN_PROGRESS' }])[0].status, 'SUBMITTED')
  const largeSnapshots = Array.from({ length: 20 }, (_, i) => ({ id: String(i), status: 'SUBMITTED', items: Array(1000).fill({ question: { stem: 'question' }, answer: ['B'] }) }))
  const smallCards = records([], largeSnapshots)
  assert(JSON.stringify(smallCards).length < 16000, '列表只传递卡片摘要')
  assert(smallCards.every(item => !('items' in item) && !('result' in item) && !('localState' in item)))
  const data = {}, storage = { get: key => data[key] && JSON.parse(JSON.stringify(data[key])), set: (key, value) => { data[key] = JSON.parse(JSON.stringify(value)) }, remove: key => delete data[key], keys: () => Object.keys(data) }
  let now = 0, attempts = 0, original
  const settings = { storage, userId: 'owner', now: () => now, random: () => 0, setTimer: () => 1, clearTimer() {}, send: async (_id, command) => {
    original = original || command
    assert.strictEqual(command.idempotencyKey, original.idempotencyKey)
    assert.deepStrictEqual(command.payload, original.payload)
    return ++attempts <= 12 ? { ok: false, statusCode: 503 } : { ok: true }
  } }
  let queue = createSyncQueue(settings)
  assert(queue.finish('session', { progress: { items: [{ answer: 'final' }] } }).ok)
  for (let i = 0; i < 13; i++) {
    now += 300001
    await queue.flush('session')
    queue.stop(); queue = createSyncQueue(settings)
  }
  assert.strictEqual(queue.get('session').finished, true)
  assert.strictEqual(queue.get('session').acknowledgedSequence, 1)
  assert(queue.save('session', { progress: { items: [{ answer: 'changed' }] } }).unchanged)
  assert.strictEqual(queue.get('session').payload.progress.items[0].answer, 'final')
  queue.stop()
  const ownerStorage = { get: key => key === 'qandaAuth' ? { provider: 'email', userId: 'owner', token: 'token' } : 'device' }
  const vm = new PracticeRecordsViewModel(ownerStorage)
  vm.local = () => Array.from({ length: 35 }, (_, i) => ({ id: 'local-' + i, status: 'IN_PROGRESS' }))
  vm.page = 5
  const request = http.request, pages = []
  http.request = async (_method, path) => { pages.push(path); return { ok: false } }
  try {
    assert.strictEqual((await vm.load(true)).items.length, 20)
    const next = await vm.load(false)
    assert.strictEqual(next.items.length, 35)
    assert.strictEqual(next.hasMore, false)
    assert(pages.every(path => path.includes('page=1&')), '离线翻页不跳过未成功读取的远端页')
    http.request = async (_method, path) => { pages.push(path); return { ok: true, data: { items: [], total: 0 } } }
    await vm.load(false)
    assert(pages.at(-1).includes('page=1&'))
    assert.strictEqual(vm.page, 1)
  } finally { http.request = request }
  console.log('practice records and durable finalization survive twelve transient failures and restarts')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
