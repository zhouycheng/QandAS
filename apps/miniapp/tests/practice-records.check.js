const assert = require('assert')
const { summarize, openRecord } = require('../miniprogram/models/practice-record-summary.js')
const { records } = require('../miniprogram/viewmodels/practice-records-viewmodel.js')
const { createSyncQueue } = require('../miniprogram/repositories/practice-sync-queue.js')
async function main() {
  const list = records([{ id: 'one', status: 'IN_PROGRESS', createdAt: '2026-11-01' }, { id: 'two', status: 'SUBMITTED', createdAt: '2026-11-02' }], [{ id: 'one', finishIntent: true, createdAt: '2026-11-03', items: [{}, {}] }])
  assert.strictEqual(list.length, 2)
  assert.strictEqual(list[0].statusText, '已交卷，等待批改中')
  assert.strictEqual(list[0].countText, '2 题')
  assert.strictEqual(list[1].statusText, '已结束')
  assert.deepStrictEqual(openRecord({ id: 'pending', status: 'WAITING', feedback: 'AFTER_FINISH' }), { type: 'toast', title: '批改中，不可进入' })
  assert.strictEqual(openRecord({ id: 'pending', status: 'WAITING', feedback: 'IMMEDIATE' }).url, '/page/practice/index?sessionId=pending&review=1')
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
    now += 60001
    await queue.flush('session')
    queue.stop(); queue = createSyncQueue(settings)
  }
  assert.strictEqual(queue.get('session').finished, true)
  assert.strictEqual(queue.get('session').acknowledgedSequence, 1)
  assert(queue.save('session', { progress: { items: [{ answer: 'changed' }] } }).unchanged)
  assert.strictEqual(queue.get('session').payload.progress.items[0].answer, 'final')
  queue.stop()
  console.log('practice records and durable finalization survive twelve transient failures and restarts')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
