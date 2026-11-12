const assert = require('node:assert/strict')
const http = require('../miniprogram/repositories/http-gateway.js')
const api = require('../miniprogram/repositories/api-transport.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const { OnlinePractice } = require('../miniprogram/repositories/online-practice.js')
const trial = require('../miniprogram/repositories/trial-practice.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const copy = value => JSON.parse(JSON.stringify(value))
function storage() {
  const values = {}
  return require('./helpers/encrypted-storage.js').encrypted({ get: key => values[key] && copy(values[key]), set: (key, value) => { values[key] = copy(value) }, remove: key => delete values[key] })
}
async function main() {
  const store = storage()
  auth.saveAuth(store, { provider: 'email', userId: 'student', token: 'token' })
  const preview = { availableCount: 2, selectedCount: 2, selectedQuestionIds: ['qa', 'qb'], contentVersion: 1, contentVersions: { a: 1, b: 3 } }
  api.request = async () => ({ ok: true, data: copy(preview) })
  const selected = await remote.previewPracticeScope(store, { questionBankId: 'a', questionBankIds: ['a', 'b'] })
  assert.deepEqual(remote.getScopePreview(store, selected.selectionKey, ['b', 'a']).contentVersions, { a: 1, b: 3 })
  assert.throws(() => remote.getScopePreview(store, selected.selectionKey, ['a']), /配置已更新/)
  const calls = []
  let next = 0
  http.request = async (method, path, body) => {
    calls.push({ method, path, body: body && copy(body) })
    if (path === '/question-banks/a') return { ok: true, data: { id: 'a', name: '题库甲', contentVersion: 1 } }
    if (path === '/practice/scope-preview') return { ok: true, data: copy(preview) }
    if (path === '/practice/sessions' || path === '/practice/trial-snapshots') return { ok: true, data: {
      id: 'practice-' + ++next, questionBankId: 'a', status: 'IN_PROGRESS', feedback: 'IMMEDIATE', currentIndex: 0, durationSeconds: 0,
      configuration: { questionBankIds: ['a', 'b'], chapterIds: [], count: 2, order: 'SEQUENTIAL', selectionKind: 'NORMAL', contentVersions: copy(preview.contentVersions), mode: 'order' },
      items: ['a', 'b'].map(id => ({ itemId: 'i' + id, question: { id: 'q' + id, revisionId: 'r' + id, questionBankId: id, type: 'SINGLE_CHOICE', stem: '题目' + id, options: [{ key: 'A', content: '选项' }], assetIds: [] } })),
      offlineGrading: ['a', 'b'].map(id => ({ itemId: 'i' + id, correctAnswer: ['A'] }))
    } }
    throw new Error('未预期请求 ' + path)
  }
  const runtime = new OnlinePractice(store)
  const route = { bankId: 'a', bankIds: 'a,b', mode: 'order', count: 2, selectionKey: selected.selectionKey }
  const result = await runtime.prepare(route)
  const created = calls.find(call => call.path === '/practice/sessions').body
  assert.deepEqual(created.scope.questionBankIds, ['a', 'b'])
  assert.deepEqual(created.scope.questionIds, ['qa', 'qb'])
  assert.deepEqual(created.expectedContentVersions, { a: 1, b: 3 })
  assert.equal(runtime.snapshotRoute(result).bankIds, 'a,b')
  const fresh = runtime.remember(Object.assign({}, result, { id: 'fresh', route: undefined, title: '' }), {})
  assert.equal(fresh.route.bankIds, 'a,b', '新设备从服务器配置还原全部题库')
  assert.equal(fresh.title, '2 个题库联合练习')
  const vm = new PracticeViewModel({ storage: store })
  vm.online = runtime; vm.routeOptions = fresh.route
  assert(vm.createRedoWrongCommand(['qa', 'qb']).command.url.includes('bankIds=a%2Cb'))
  assert(vm.createRedoWrongCommand(['qa', 'qb']).command.url.includes('selectionKind=WRONG'))
  await runtime.prepare({ bankId: 'a', bankIds: 'a,b', mode: 'test', ids: 'qa,qb' })
  assert(calls.some(call => call.path === '/practice/scope-preview'), '重练无旧预览时重新确认所有题库版本')
  runtime.queue.stop()
  const guest = storage()
  const trialSnapshot = await trial.prepare(guest, { bankId: 'a', bankIds: 'a,b', mode: 'order' })
  assert.equal(trialSnapshot.items.length, 2)
  assert.equal(trialSnapshot.route.bankIds, 'a,b')
  const trialBody = calls.find(call => call.path === '/practice/trial-snapshots').body
  assert.deepEqual(trialBody.expectedContentVersions, { a: 1, b: 3 })
  assert.deepEqual(trialBody.scope.questionBankIds, ['a', 'b'])
  assert.equal(trial.remaining(guest), 1, '联合题库仍是一场试答')
  console.log('多题库练习自检通过：范围预览、创建、版本、恢复、重练与游客试答')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
