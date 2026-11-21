// Invoked by the PostgreSQL integration fixture; credentials are supplied only through the process environment.
const assert = require('node:assert/strict')
const api = require('../miniprogram/repositories/api-transport.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const online = require('../miniprogram/repositories/online-practice.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const { QuestionDetailViewModel } = require('../miniprogram/viewmodels/question-detail-viewmodel.js')
const source = process.env
if (!source.QANDA_TEST_URL || !source.QANDA_TEST_TOKEN || !source.QANDA_TEST_BANK_ID || !source.QANDA_TEST_USER_ID) throw new Error('需要隔离的后端验收环境')
const values = new Map()
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const makeStorage = data => require('./helpers/encrypted-storage.js').encrypted({ get: key => copy(data.get(key)), set: (key, value) => data.set(key, copy(value)), remove: key => data.delete(key), keys: () => [...data.keys()] })
let storage = makeStorage(values)
let loseReleaseResponse = true, loseClaimResponse = true
let offline = false, finishRequest
const requests = []
global.wx = { request(options) {
  if (offline) { options.fail({ errMsg: 'fixture offline' }); return }
  const url = new URL(options.url)
  if (options.method === 'POST' && url.pathname.endsWith('/sync-commands') && options.data.kind === 'FINISH') {
    finishRequest = { url: options.url, headers: options.header, body: JSON.stringify(options.data) }
  }
  const read = options.method === 'GET'
  if (read) Object.entries(options.data || {}).forEach(([key, value]) => url.searchParams.set(key, value))
  requests.push({ method: options.method, path: url.pathname })
  fetch(url, { method: options.method, headers: options.header, body: read ? undefined : JSON.stringify(options.data || {}) })
    .then(async response => {
      if (response.ok && url.pathname.endsWith('/release-writer') && loseReleaseResponse) { loseReleaseResponse = false; options.fail({ errMsg: 'simulated response loss' }); return }
      if (response.ok && url.pathname.endsWith('/claim-writer') && loseClaimResponse) { loseClaimResponse = false; options.fail({ errMsg: 'simulated response loss' }); return }
      options.success({ statusCode: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : null, header: Object.fromEntries(response.headers) })
    })
    .catch(error => options.fail({ errMsg: error.message }))
} }
async function offlineDeletion(bank, runtime) {
  const vm = new PracticeViewModel({ storage })
  await vm.load({ bankId: bank.id, subjectId: bank.subjectId, mode: 'order', count: '4' })
  const id = vm.session.meta.sessionId
  const path = '/practice/sessions/' + id
  const read = async route => {
    const response = await api.request('GET', route, null, { token: source.QANDA_TEST_TOKEN })
    assert.equal(response.statusCode, 200, route)
    return response.data
  }
  const before = await read('/me/statistics?period=ALL')
  const index = vm.session.state.questions.findIndex(question => question.isShortAnswer)
  assert(index >= 0)
  offline = true
  await vm.jumpToQuestion(index)
  vm.setAnswerText('离线退出前的作答')
  vm.toggleMarkQuestion()
  await vm.suspendWriter()
  assert(!runtime.queue.isIdle(id))
  runtime.queue.stop()

  // The admin request uses a separate connection while student transport remains offline.
  const bankUrl = source.QANDA_TEST_URL + '/api/v1/admin/question-banks/' + bank.id
  const headers = { Authorization: 'Bearer ' + source.QANDA_TEST_ADMIN_TOKEN }
  const detail = await fetch(bankUrl, { headers })
  assert.equal(detail.status, 200)
  const deletion = await fetch(bankUrl + '?expectedVersion=' + (await detail.json()).version, {
    method: 'DELETE', headers: { ...headers, 'Idempotency-Key': api.uuid() },
  })
  assert.equal(deletion.status, 200)

  offline = false
  const beforeSync = await read(path)
  assert.equal(beforeSync.items[index].answer, null)
  runtime = online.enable(storage)
  runtime.identity()
  async function drain() {
    const deadline = Date.now() + 45000
    while (!runtime.queue.isIdle(id)) {
      assert(Date.now() < deadline, '离线队列未按时清空')
      await runtime.flush(id)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  await drain()
  const saved = await read(path)
  assert.equal(saved.status, 'IN_PROGRESS')
  assert.equal(saved.currentIndex, index)
  assert.equal(saved.items[index].answer.text, '离线退出前的作答')
  assert.equal(saved.items[index].marked, true)
  const resumed = new PracticeViewModel({ storage })
  await resumed.load({ sessionId: id })
  await resumed.forceSubmit()
  await drain()
  const result = await read(path + '/result')
  assert.equal(result.answeredCount, 1)
  assert.equal(result.items[index].question.stem, saved.items[index].question.stem)
  assert.equal(result.items[index].answer.text, saved.items[index].answer.text)
  assert.equal(finishRequest.url, source.QANDA_TEST_URL + '/api/v1' + path + '/sync-commands')
  const replay = await fetch(finishRequest.url, { method: 'POST', headers: finishRequest.headers, body: finishRequest.body })
  assert.equal(replay.status, 202)
  assert.equal((await replay.json()).state, 'COMMITTED')
  const stats = await read('/me/statistics?period=ALL')
  assert.equal(stats.practiceCount, before.practiceCount + 1)
  assert.equal(stats.answeredCount, before.answeredCount + 1)
  assert.deepEqual(await read(path + '/result'), result)
  runtime.queue.stop()
  return id
}
async function main() {
  api.configure({ baseUrl: source.QANDA_TEST_URL, tokenProvider: () => auth.getAuth(storage).token || source.QANDA_TEST_TOKEN })
  auth.saveAuth(storage, { provider: 'email', userId: source.QANDA_TEST_USER_ID, token: source.QANDA_TEST_TOKEN, email: 'fixture@example.test' })
  storage.set('qandaDeviceId', source.QANDA_TEST_DEVICE_ID)
  remote.enable(true); remote.bind(storage)
  await remote.loadBank(storage, source.QANDA_TEST_BANK_ID)
  const bank = remote.getBankMeta(source.QANDA_TEST_BANK_ID)
  assert.ok(bank, '真实目录包含验收题库')
  const preferences = require('../miniprogram/repositories/preference-repository.js')
  await preferences.refreshPreferences(storage)
  const configured = preferences.getPreferences(storage)
  configured.examCountdowns = [{ id: 'exam-live', examName: '期末考试', examDate: '2026-12-20' }]
  configured.fontSize = 'large'
  preferences.savePreferences(storage, configured)
  await preferences.refreshPreferences(storage)
  let runtime = online.enable(storage)
  let vm = new PracticeViewModel({ storage })
  let view = await vm.load({ bankId: bank.id, subjectId: bank.subjectId, mode: 'order', count: '4' })
  assert.equal(view.data.total, 4)
  assert.equal(view.data.currentCorrectAnswerText, '')
  assert.equal(view.data.currentQuestion.answerKeys, undefined)
  assert.equal(view.data.questions[0].answerKeys, undefined)
  const originalRuntime = runtime
  const practiceId = vm.session.meta.sessionId
  vm.session.accumulatedMs = 3000
  await vm.jumpToQuestion(1)
  const uncertain = await vm.releaseWriter()
  assert(!uncertain.released && uncertain.data.editingLocked, '交接丢响应时先锁定编辑')
  assert((await vm.releaseWriter()).released, '相同交接请求可恢复')
  runtime.queue.stop()
  storage = makeStorage(new Map())
  auth.saveAuth(storage, { provider: 'email', userId: source.QANDA_TEST_USER_ID, token: source.QANDA_TEST_OTHER_TOKEN })
  storage.set('qandaDeviceId', source.QANDA_TEST_OTHER_DEVICE_ID)
  remote.enable(true); remote.bind(storage)
  await preferences.refreshPreferences(storage)
  assert.deepEqual(preferences.getPreferences(storage), configured, '账号设置通过真实 HTTP 在新设备读取')
  runtime = online.enable(storage); vm = new PracticeViewModel({ storage })
  await assert.rejects(vm.load({ sessionId: practiceId }), /网络请求失败/)
  view = await vm.load({ sessionId: practiceId })
  assert.equal(vm.session.state.currentIndex, 1)
  assert(vm.session.getElapsedSeconds() >= 3)
  assert.equal(runtime.queue.get(practiceId).sequence, 1, '新设备从已确认序号继续')
  for (let index = 0; index < vm.session.state.questions.length; index += 1) {
    await vm.jumpToQuestion(index)
    const question = vm.session.state.questions[index]
    if (question.isShortAnswer) {
      vm.setAnswerText('自主练习验收作答')
      await vm.goNext()
    } else {
      question.answerKeys.forEach(key => vm.selectOption(question.options.findIndex(option => option.key === key)))
      if (question.isMultiple) await vm.goNext()
    }
  }
  await vm.forceSubmit()
  assert(runtime.get(vm.session.meta.sessionId).localResult, '接续后必须成功保存交卷意图')
  const deadline = Date.now() + 45000
  while (!runtime.get(vm.session.meta.sessionId).cloudConfirmed) {
    const task = runtime.queue.get(vm.session.meta.sessionId)
    assert(Date.now() < deadline, JSON.stringify({ message: 'async finish timed out', sequence: task.sequence, acknowledged: task.acknowledgedSequence, pending: task.pending && task.pending.kind, paused: task.paused, status: task.lastStatusCode, reason: task.reason }))
    await runtime.flush(vm.session.meta.sessionId)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  vm.applyOfficialResult(runtime.get(vm.session.meta.sessionId).localResult)
  vm.editingLocked = false
  const subjective = vm.session.state.questions.find(question => question.isShortAnswer)
  await vm.assessResult(subjective.id, 'CORRECT')
  const completed = runtime.get(vm.session.meta.sessionId)
  assert.equal(completed.status, 'SUBMITTED')
  assert.equal(completed.localResult.objective.wrong, 0)
  assert.equal(completed.localResult.shortAnswer.rated, 1)
  assert.equal(runtime.queue.get(completed.id).sequence, runtime.queue.get(completed.id).acknowledgedSequence)
  remote.invalidateLearning()
  await Promise.all([remote.refresh(storage, 'home'), remote.refresh(storage, 'recent')])
  const recent = remote.getRecent(storage)
  assert.ok(recent.some(item => item.id === completed.id && item.status === 'SUBMITTED'), JSON.stringify({ recentCount: recent.length, statuses: recent.map(item => item.status), cloudConfirmed: completed.cloudConfirmed }))
  assert.ok(requests.some(item => item.path.endsWith('/sync-commands')))
  assert.ok(requests.every(item => item.path.startsWith('/api/v1/')))
  for (const item of completed.items) {
    const id = item.question.id
    const hidden = await api.request('GET', '/questions/' + id)
    assert.equal(hidden.data.correctAnswer, null)
    assert.equal(hidden.data.explanation, null)
    const detail = new QuestionDetailViewModel({ storage })
    const review = (await detail.refreshRemote({ id, latest: '1' })).data
    assert.equal(review.emptyText, '')
    assert.equal(review.canReveal, true)
    assert.ok(review.correctText, item.question.type)
    assert.equal(review.hasAnswer, false)
    detail.release(); remote.releaseQuestion(id)
  }
  const originalDeviceResult = await originalRuntime.prepare({ sessionId: completed.id, review: '1' })
  assert.equal(originalDeviceResult.status, 'SUBMITTED', '原设备读取另一设备交卷后的结果')
  assert.equal(originalDeviceResult.result.shortAnswer.rated, 1)
  const offlineSessionId = await offlineDeletion(bank, runtime)
  console.log(JSON.stringify({ passed: true, offlineSessionId, requests: requests.length, questions: view.data.total, objectiveCorrect: completed.localResult.objective.correct, selfRated: completed.localResult.shortAnswer.rated, crossDevice: true, recoveredHandoffResponses: true }))
}
main().catch(error => { const runtime = online.current(); if (runtime && runtime.queue) runtime.queue.stop(); console.error(error.message); process.exitCode = 1 })
