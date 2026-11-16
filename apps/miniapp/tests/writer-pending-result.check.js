const assert = require('node:assert/strict')
const { OnlinePractice } = require('../miniprogram/repositories/online-practice.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const copy = value => value && JSON.parse(JSON.stringify(value))

async function main() {
  const values = { qandaAuth: { provider: 'email', userId: 'owner', token: 'token' }, qandaDeviceId: 'phone' }
  const storage = require('./helpers/encrypted-storage.js').encrypted({ get: key => copy(values[key]), set: (key, value) => { values[key] = copy(value) }, remove: key => delete values[key], keys: () => Object.keys(values) })
  const online = new OnlinePractice(storage)
  online.identity()
  const pending = { id: 'practice', status: 'IN_PROGRESS', version: 2, items: [], route: {}, writer: { deviceId: 'phone', epoch: 2 }, localResult: { id: 'practice', items: [] }, cloudConfirmed: false }
  const save = () => {
    online.put('practice', copy(pending))
    online.queue.finish('practice', { progress: { items: [] }, state: { status: 'SUBMITTED' }, clientResult: { totalCount: 0 } })
    online.queue.stop()
  }
  save()
  online.writerState = async () => ({ status: 'SUBMITTED', writer: { epoch: 2, deviceId: 'phone' } })
  assert((await online.prepare({ sessionId: 'practice' })).localResult, '同代次的交卷继续由原可靠队列恢复回执')
  online.writerState = async () => { throw new Error('离线') }
  assert((await online.prepare({ sessionId: 'practice' })).localResult, '临时断网保留本机成绩')
  online.writerState = async () => { throw Object.assign(new Error('登录失效'), { statusCode: 401 }) }
  await assert.rejects(online.prepare({ sessionId: 'practice' }), /登录失效/)
  online.writerState = async () => ({ status: 'IN_PROGRESS', writer: { epoch: 3, deviceId: 'computer' } })
  await assert.rejects(online.prepare({ sessionId: 'practice', passive: '1' }), error => error.code === 'WRITER_CHANGED')
  assert.equal(online.get('practice'), null, '旧成绩从活动快照移出')
  assert.equal(storage.get('qandaPracticeRecords:owner').practice, undefined)
  assert(online.detachedSnapshot('practice').localResult, '未上传的交卷仍可只读查看')
  assert(online.queue.isIdle('practice'), '旧交卷不能再次上传覆盖另一端')
  save()
  online.writerState = async () => ({ status: 'SUBMITTED', writer: { epoch: 4, deviceId: 'computer' } })
  online.required = async (_method, path) => path.endsWith('/result') ? { id: 'official', items: [] } : { id: 'practice', version: 5, status: 'SUBMITTED', items: [], route: {}, writer: { epoch: 4, deviceId: 'computer' } }
  const official = await online.prepare({ sessionId: 'practice', review: '1' })
  assert.equal(official.result.id, 'official'); assert.equal(official.cloudConfirmed, true)
  assert.equal(online.get('practice').localResult, undefined, '刷新后不从旧队列重建成绩')
  assert(online.detachedSnapshot('practice').localResult)
  assert(online.restoreDetached(), '归档草稿自动恢复供后台续传')
  assert.equal(storage.get('qandaOnline:owner:practice:detached'), undefined, '恢复后清理归档入口')
  save()
  online.writerState = async () => { storage.set('qandaAuth', { provider: 'email', userId: 'other', token: 'other-token' }); throw new Error('账号已切换') }
  await assert.rejects(online.prepare({ sessionId: 'practice' }), /账号已切换/)
  online.queue.stop()

  const soloValues = { qandaAuth: { provider: 'email', userId: 'solo', token: 'token' }, qandaDeviceId: 'd' }
  const soloStorage = require('./helpers/encrypted-storage.js').encrypted({ get: key => copy(soloValues[key]), set: (key, value) => { soloValues[key] = copy(value) }, remove: key => delete soloValues[key], keys: () => Object.keys(soloValues) })
  const solo = new OnlinePractice(soloStorage)
  solo.identity()
  soloStorage.set('qandaOnline:solo:only:detached', { snapshot: { id: 'only', status: 'IN_PROGRESS', version: 1, items: [], route: {}, writer: { deviceId: 'd', epoch: 1 } }, draft: { userId: 'solo', sessionId: 'only', revision: 1, acknowledgedRevision: 0, sequence: 3, acknowledgedSequence: 0, acceptedSequence: 0, pending: null, payload: { progress: { items: [] } }, failures: 0 }, savedAt: new Date().toISOString() })
  assert(solo.restoreDetached(), '仅剩归档数据时也能自动恢复')
  assert.equal(soloStorage.get('qandaOnline:solo:only').id, 'only', '恢复归档快照主体')
  assert.equal(soloStorage.get('qandaSync:v1:solo:only').sequence, 3, '恢复归档队列草稿')
  assert(solo.queue.get('only'), '队列可读取恢复的草稿')
  assert(solo.get('only'), 'get 走 vault 恢复路径读取快照')
  solo.queue.stop()

  const vm = new PracticeViewModel({ repository: { getAuth: () => ({ userId: 'owner' }) } })
  vm.online = {}; vm.ownerId = 'owner'
  vm.session = { meta: { sessionId: 'practice' }, state: { isCompleted: true } }
  vm.answerSnapshot = copy(pending)
  let loads = 0
  vm.loadOnline = async options => { assert.equal(options.passive, '1'); loads++; return { refreshed: true } }
  assert((await vm.checkWriter()).refreshed, '结果页回前台核验未确认交卷的授权')
  vm.answerSnapshot.cloudConfirmed = true
  assert.equal(await vm.checkWriter(), null); assert.equal(loads, 1)
  console.log('离线交卷遇到新代次时隔离旧成绩，保留可靠队列并刷新云端结果')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
