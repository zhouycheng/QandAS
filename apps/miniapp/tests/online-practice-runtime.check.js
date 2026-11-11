const assert = require('assert')
const http = require('../miniprogram/repositories/http-gateway.js')
const { OnlinePractice } = require('../miniprogram/repositories/online-practice.js')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const onlinePractice = require('../miniprogram/repositories/online-practice.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const copy = (v) => JSON.parse(JSON.stringify(v))
async function main() {
  const data = { qandaAuth: { provider: 'email', userId: 'u1', token: 'token1' } }
  let full = false
  const storage = { get: (k) => data[k] && copy(data[k]), set: (k, v) => { if (full) throw new Error('full'); data[k] = copy(v) }, remove: (k) => delete data[k] }
  const requests = []
  const writer = { state: 'ACTIVE', deviceId: 'device1', writerToken: 'writer1', pendingDeviceId: null, version: 1, acknowledgedSequence: 0, updatedAt: new Date().toISOString() }
  storage.set('qandaDeviceId', 'device1')
  let createLost = true
  let offline = false
  let failProgressResponse = false
  let holdProgress = false
  let finishLost = false
  let ratingLost = false
  let submitted = false
  let version = 1
  const replies = {}
  const routeStorageData = { qandaAuth: { provider: 'email', userId: 'route-user', token: 'route-token' }, qandaDeviceId: 'route-device' }
  const routeStorage = { get: key => routeStorageData[key] && copy(routeStorageData[key]), set: (key, value) => { routeStorageData[key] = copy(value) }, remove: key => delete routeStorageData[key] }
  const routeRuntime = new OnlinePractice(routeStorage)
  routeRuntime.identity()
  routeRuntime.put('route-session', { id: 'route-session', title: '已归档题库', route: { mode: 'test', duration: '25', subjectId: 'subject-1' } })
  const routed = routeRuntime.remember({ id: 'route-session', questionBankId: 'bank-1' }, { sessionId: 'route-session' })
  assert.strictEqual(routed.route.duration, '25')
  assert.strictEqual(routed.route.subjectId, 'subject-1')
  assert.strictEqual(routed.title, '已归档题库')
  routeRuntime.queue.stop()
  const snapshot = { id: 's1', questionBankId: 'b1', status: 'IN_PROGRESS', version: 1, currentIndex: 0, durationSeconds: 0, feedback: 'IMMEDIATE', configuration: { chapterIds: [], count: 1, order: 'SEQUENTIAL', selectionKind: 'NORMAL', feedback: 'IMMEDIATE', contentVersion: 1 }, writer, items: [{ itemId: 'i1', position: 0, question: { id: 'q1', revisionId: 'r1', questionBankId: 'b1', type: 'SINGLE_CHOICE', stem: '题干', options: [{ key: 'A', content: '选项甲' }, { key: 'B', content: '选项乙' }], correctAnswer: null, correctValue: null, referenceAnswer: null, explanation: null, assetIds: [] }, answer: null, confirmed: false, marked: false, outcome: null, selfAssessment: null }], offlineGrading: [{ itemId: 'i1', correctAnswer: ['A'], correctValue: null, referenceAnswer: null, explanation: '解析仅答后显示' }] }
  const unified = new PracticeSession({ quiz: new OnlinePractice(storage).quiz(Object.assign({ route: {} }, snapshot)), mode: 'test' })
  unified.reset()
  unified.selectOption(0)
  unified.openQuestionOverview()
  assert.strictEqual(unified.getViewData().overviewItems[0].isCorrect, false, '统一反馈交卷前不展示判定')
  assert.strictEqual(unified.getViewData().currentCorrectAnswerText, '')
  assert.strictEqual(unified.forceSubmit().data.overviewItems[0].isCorrect, true, '统一反馈交卷后展示判定')
  const result = { id: 'result1', sessionId: 's1', version: 3, totalCount: 1, answeredCount: 1, durationSeconds: 1, objective: { count: 1, answered: 1, correct: 1, wrong: 0, unanswered: 0, accuracy: 1 }, shortAnswer: { count: 0, answered: 0, rated: 0, correct: 0, wrong: 0, unrated: 0 }, items: snapshot.items, submittedAt: new Date().toISOString() }
  global.wx = { request(input) {
    requests.push({ url: input.url, method: input.method, data: copy(input.data), header: copy(input.header) })
    if (offline) { input.fail({ errMsg: 'request:fail offline' }); return }
    const key = input.header['Idempotency-Key']
    let body
    if (input.url.endsWith('/question-banks/b1')) body = { id: 'b1', name: '题库', contentVersion: 1, questionCount: 1 }
    else if (input.url.endsWith('/practice/sessions')) {
      if (!replies[key]) replies[key] = snapshot
      body = replies[key]
      if (createLost) { createLost = false; input.fail({ errMsg: 'request:fail timeout' }); return }
    }
    else if (input.url.endsWith('/sync-commands')) {
      if (!replies[key]) replies[key] = { state: 'COMMITTED', acknowledgement: { id: 's1', version: ++version, acknowledgedSequence: input.data.clientSequence, writer: Object.assign({}, writer, { version, acknowledgedSequence: input.data.clientSequence }) }, result: input.data.kind === 'FINISH' ? result : null }
      body = holdProgress ? { state: 'QUEUED', acknowledgement: null } : replies[key]
      if (input.data.kind === 'FINISH') { submitted = true; if (finishLost) { finishLost = false; input.fail({ errMsg: 'request:fail timeout' }); return } }
      if (failProgressResponse) { failProgressResponse = false; input.fail({ errMsg: 'request:fail timeout' }); return }
    } else if (/\/sync-commands\/[^/]+$/.test(input.url)) {
      const known = replies[input.url.split('/').pop()]
      if (!known) { input.success({ statusCode: 404, data: { code: 'NOT_FOUND' } }); return }
      body = holdProgress ? { state: 'QUEUED', acknowledgement: null } : known
    } else if (input.url.endsWith('/cancel')) {
      body = { id: input.url.split('/').slice(-2)[0], version: input.data.expectedVersion + 1 }
    } else if (input.url.endsWith('/self-assessment')) {
      const match = input.url.match(/\/practice\/sessions\/([^/]+)\/items\/([^/]+)\/self-assessment/)
      const items = storage.get(`qandaOnline:u1:${match[1]}`).items
      items.find(item => item.itemId === match[2]).selfAssessment = input.data.assessment
      body = Object.assign({}, result, { version: input.data.expectedVersion + 1, sessionId: match[1], items })
      if (ratingLost) { ratingLost = false; input.fail({ errMsg: 'request:fail timeout' }); return }
    } else throw new Error(`Unexpected route ${input.url}`)
    input.success({ statusCode: 200, data: copy(body) })
  } }
  http.configure({ baseUrl: 'https://example.test' })
  async function flushNow(runtime, id) {
    const draft = runtime.queue.get(id)
    if (draft) { draft.nextAttemptAt = 0; storage.set(`qandaSync:v1:u1:${id}`, draft) }
    return runtime.flush(id)
  }
  let runtime = new OnlinePractice(storage)
  await assert.rejects(() => runtime.prepare({ bankId: 'b1', mode: 'practice' }), /请求超时/)
  runtime.queue.stop()
  runtime = new OnlinePractice(storage)
  const created = await runtime.prepare({ bankId: 'b1', mode: 'practice' })
  assert.strictEqual(created.configuration.feedback, 'IMMEDIATE')
  const creations = requests.filter(r => r.url.endsWith('/practice/sessions'))
  assert.strictEqual(creations.length, 2)
  assert.strictEqual(creations[0].header['Idempotency-Key'], creations[1].header['Idempotency-Key'])
  assert.deepStrictEqual(creations[0].data, creations[1].data)
  assert.strictEqual(requests.filter(r => r.url.endsWith('/question-banks/b1')).length, 1)
  assert.deepStrictEqual(storage.get('qandaOnlineCreate:u1'), [])
  await runtime.prepare({ bankId: 'b1', mode: 'practice', seed: 'new-attempt' })
  assert.strictEqual(requests.filter(r => r.url.endsWith('/question-banks/b1')).length, 2, '新一轮练习重新校验元数据，已发送创建请求重试仍复用原内容')
  const session = new PracticeSession({ quiz: runtime.quiz(created), restored: runtime.restored(created), mode: 'practice', config: created.route })
  session.reset(); session.restore(runtime.restored(created))
  const initial = session.getViewData()
  assert(!JSON.stringify(initial).includes('解析仅答后显示'))
  assert(!Object.prototype.hasOwnProperty.call(initial.questions[0], 'answerKeys'))
  assert.strictEqual(initial.currentCorrectAnswerText, '')
  session.selectOption(0)
  assert.strictEqual(session.getViewData().shouldRevealAnswer, true)
  assert.strictEqual(session.getViewData().currentExplanation, '解析仅答后显示')
  runtime.save(session)
  failProgressResponse = true
  assert.strictEqual((await runtime.flush('s1')).ok, false)
  const before = runtime.queue.get('s1').pending
  runtime.queue.stop()
  offline = true
  const restarted = new OnlinePractice(storage)
  const restored = await restarted.prepare({ sessionId: 's1' })
  assert.strictEqual(restored.localState.answers[0].selectedKeys[0], 'A')
  assert.strictEqual(restarted.queue.get('s1').pending.idempotencyKey, before.idempotencyKey)
  offline = false
  await flushNow(restarted, 's1')
  assert.strictEqual(restarted.queue.get('s1').acknowledgedSequence, before.sequence)
  const progressRequests = requests.filter(r => r.url.endsWith('/sync-commands'))
  assert.strictEqual(progressRequests.length, 1, '响应丢失后先对账，已接收内容无需重传')
  full = true
  assert.throws(() => restarted.save(session), /full/)
  assert.strictEqual(restarted.saveStatus('s1').saveStatusText, '本机保存失败，请重试')
  full = false
  session.preferences.autoAddWrongBook = false
  session.finish()
  finishLost = true
  assert.strictEqual(await restarted.finish(session), null)
  await flushNow(restarted, 's1')
  const durableFinish = restarted.queue.get('s1').pending
  assert(durableFinish)
  restarted.queue.stop()
  const finishRecovery = new OnlinePractice(storage); finishRecovery.identity()
  await flushNow(finishRecovery, 's1')
  assert.strictEqual(finishRecovery.get('s1').status, 'SUBMITTED')
  const finishRequests = requests.filter(r => r.url.endsWith('/sync-commands') && r.data.kind === 'FINISH')
  assert.strictEqual(finishRequests[0].data.autoAddWrongBook, false)
  assert.strictEqual(finishRecovery.queue.get('s1').acknowledgedSequence, durableFinish.sequence)
  finishRecovery.queue.stop()
  const ratedSnapshot = Object.assign({}, snapshot, { id: 's2', status: 'SUBMITTED', result: Object.assign({}, result, { sessionId: 's2' }), version: 3 })
  restarted.put('s2', ratedSnapshot)
  const shortSession = { meta: { sessionId: 's2' }, state: { answers: [{ selfAssessment: 'CORRECT' }] } }
  ratingLost = true
  await assert.rejects(() => restarted.finish(shortSession), /请求超时/)
  assert.strictEqual(restarted.get('s2').status, 'SUBMITTED')
  assert(restarted.get('s2').result)
  assert(restarted.get('s2').assessmentCommands.i1)
  const finalRating = await restarted.finish(shortSession)
  assert.strictEqual(finalRating.version, 4)
  const ratingRequests = requests.filter(r => r.url.endsWith('/self-assessment'))
  assert.strictEqual(ratingRequests[0].header['Idempotency-Key'], ratingRequests[1].header['Idempotency-Key'])
  assert.deepStrictEqual(ratingRequests[0].data, ratingRequests[1].data)
  assert.strictEqual(restarted.get('s2').assessmentCommands.i1, undefined)
  const shortSnapshot = Object.assign({}, copy(ratedSnapshot), {
    id: 's4',
    route: { bankId: 'b1', mode: 'practice' },
    items: copy(ratedSnapshot.items),
    result: Object.assign({}, result, { sessionId: 's4' }),
    assessmentCommands: {},
    assessed: {}
  })
  shortSnapshot.items[0].itemId = 'i4'
  shortSnapshot.items[0].question.type = 'SHORT_ANSWER'
  shortSnapshot.items[0].question.options = []
  shortSnapshot.items[0].answer = { text: '我的作答' }
  shortSnapshot.items[0].confirmed = true
  shortSnapshot.items[0].outcome = 'SELF_RATED'
  shortSnapshot.items[0].selfAssessment = 'WRONG'
  restarted.put('s4', shortSnapshot)
  const assessmentVm = new PracticeViewModel({ storage, repository: { getPreferences: () => ({}) } })
  assessmentVm.online = restarted
  const assessmentState = restarted.restored(shortSnapshot)
  assessmentVm.session = new PracticeSession({ quiz: restarted.quiz(shortSnapshot), restored: assessmentState, mode: 'practice' })
  assessmentVm.session.reset()
  assessmentVm.session.restore(assessmentState)
  assessmentVm.session.finish()
  assessmentVm.session.setResultFilter('wrong')
  ratingLost = true
  await assert.rejects(() => assessmentVm.assessResult('q1', 'CORRECT'), /请求超时/)
  const pendingAssessment = restarted.get('s4').assessmentCommands.i4
  assert(pendingAssessment)
  await assessmentVm.assessResult('q1', 'CORRECT')
  const resultAssessmentRequests = requests.filter(r => r.url.includes('/sessions/s4/') && r.url.endsWith('/self-assessment'))
  assert.strictEqual(resultAssessmentRequests.length, 2)
  assert.strictEqual(resultAssessmentRequests[0].header['Idempotency-Key'], resultAssessmentRequests[1].header['Idempotency-Key'])
  assert.deepStrictEqual(resultAssessmentRequests[0].data, resultAssessmentRequests[1].data)
  assert.strictEqual(restarted.get('s4').assessmentCommands.i4, undefined)
  assert.strictEqual(restarted.get('s4').assessed.i4, 'CORRECT')
  assert.strictEqual(assessmentVm.session.state.answers[0].selfAssessment, 'CORRECT')
  assert.strictEqual(assessmentVm.session.state.overviewItems[0].isCorrect, false)
  assert.deepStrictEqual(assessmentVm.session.state.wrongQuestionIds, [])
  assert.strictEqual(assessmentVm.session.state.hasWrongQuestions, false)
  assert.strictEqual(assessmentVm.session.state.resultFilter, 'wrong')
  assert.strictEqual(assessmentVm.session.state.filteredResultItems.length, 0)
  await assessmentVm.assessResult('q1', 'WRONG')
  assert.strictEqual(assessmentVm.session.state.answers[0].isCorrect, false)
  assert.strictEqual(assessmentVm.session.state.overviewItems[0].isCorrect, false)
  assert.deepStrictEqual(assessmentVm.session.state.wrongQuestionIds, [])
  assert.strictEqual(assessmentVm.session.state.wrongCount, 0)
  assert.strictEqual(assessmentVm.session.state.filteredResultItems.length, 0)
  const pairedAssessment = Object.assign({}, copy(shortSnapshot), { id: 's7', version: 3, result: Object.assign({}, result, { sessionId: 's7' }), assessmentCommands: {}, assessed: {} })
  pairedAssessment.items = [copy(shortSnapshot.items[0]), copy(shortSnapshot.items[0])]
  pairedAssessment.items.forEach((item, index) => { item.itemId = `i7${index}`; item.question.id = `q7${index}` })
  restarted.put('s7', pairedAssessment)
  ratingLost = true
  await assert.rejects(() => restarted.assess('s7', 'i70', 'CORRECT'), /请求超时/)
  await restarted.assess('s7', 'i71', 'CORRECT')
  const pairedRequests = requests.filter(r => r.url.includes('/sessions/s7/') && r.url.endsWith('/self-assessment'))
  assert.strictEqual(pairedRequests.length, 3)
  assert.strictEqual(pairedRequests[0].header['Idempotency-Key'], pairedRequests[1].header['Idempotency-Key'])
  assert.deepStrictEqual(pairedRequests[0].data, pairedRequests[1].data)
  assert.strictEqual(pairedRequests[2].data.expectedVersion, 4, '新题自评使用前一题确认后的版本')
  const beforeConcurrentAssessment = requests.length
  await Promise.all([restarted.assess('s7', 'i70', 'WRONG'), restarted.assess('s7', 'i71', 'WRONG')])
  assert.deepStrictEqual(requests.slice(beforeConcurrentAssessment).map(r => r.data.expectedVersion), [5, 6], '同一练习内的连续点击串行提交')
  ratingLost = true
  await assert.rejects(() => restarted.assess('s7', 'i70', 'CORRECT'), /请求超时/)
  await restarted.assess('s7', 'i70', 'WRONG')
  assert.strictEqual(restarted.get('s7').version, 9)
  assert.strictEqual(restarted.get('s7').assessed.i70, 'WRONG', '先确认丢失响应的命令，再提交最新自评')
  assert.deepStrictEqual(restarted.get('s7').assessmentCommands, {})
  submitted = false
  finishLost = true
  const restoreRuntime = onlinePractice.enable(storage)
  restoreRuntime.identity()
  const restoreSnapshot = Object.assign({}, copy(snapshot), { id: 's3', status: 'IN_PROGRESS', route: { mode: 'test', duration: '20', bankId: 'b1' }, result: null, finishCommand: null })
  restoreSnapshot.writer = Object.assign({}, writer)
  const restoreState = restoreRuntime.restored(restoreSnapshot)
  restoreState.sessionId = 's3'
  restoreState.status = 'SUBMITTED'
  restoreState.config = restoreSnapshot.route
  restoreState.answers[0] = { questionId: 'q1', selectedKeys: ['A'], confirmed: true, isCorrect: true }
  restoreSnapshot.localState = restoreState
  restoreRuntime.put('s3', restoreSnapshot)
  const restoredVm = new PracticeViewModel({ storage, repository: { getPreferences: () => ({}), getAuth: value => Object.assign({ loggedIn: true }, value.get('qandaAuth')) } })
  const restoreResult = await restoredVm.load({ sessionId: 's3' })
  assert.strictEqual(restoreResult.command.url, '/page/practice-records/index')
  await flushNow(restoreRuntime, 's3')
  await flushNow(restoreRuntime, 's3')
  assert.strictEqual(restoreRuntime.get('s3').status, 'SUBMITTED')
  restoreRuntime.put('s6', Object.assign({}, copy(snapshot), { id: 's6', route: { bankId: 'b1', mode: 'view' } }))
  const viewVm = new PracticeViewModel({ storage, repository: { getPreferences: () => ({}), saveSession: () => {} } })
  const resumedView = await viewVm.loadOnline({ sessionId: 's6' })
  assert.strictEqual(resumedView.data.isViewMode, true)
  assert.strictEqual(resumedView.data.shouldRevealAnswer, true)
  assert.strictEqual(resumedView.data.currentExplanation, '解析仅答后显示')
  viewVm.persistSession(true)
  assert(restoreRuntime.get('s6').localState, '背题位置保存在快照中')
  offline = true
  await viewVm.goNext()
  const viewClose = storage.get('qandaViewClosures:u1').s6
  assert(viewClose, '离线读完后保留结束命令')
  assert(restoreRuntime.get('s6').viewCompleted)
  offline = false
  const closingRuntime = new OnlinePractice(storage)
  await closingRuntime.flushViewClosures()
  assert.strictEqual(closingRuntime.get('s6').status, 'CANCELLED', '背题结束不产生答题成绩')
  assert.deepStrictEqual(storage.get('qandaViewClosures:u1'), {})
  const closeCalls = requests.filter(r => r.url.endsWith('/s6/cancel'))
  assert.strictEqual(closeCalls[0].header['Idempotency-Key'], closeCalls[1].header['Idempotency-Key'])
  assert.deepStrictEqual(closeCalls[0].data, closeCalls[1].data)
  closingRuntime.queue.stop()
  restoreRuntime.queue.stop()
  restarted.queue.stop()
  submitted = false
  const processing = new OnlinePractice(storage)
  processing.identity()
  const waitingSnapshot = Object.assign({}, copy(snapshot), { id: 'waiting', route: {} })
  processing.put('waiting', waitingSnapshot)
  const waitingSession = new PracticeSession({ quiz: processing.quiz(waitingSnapshot), restored: processing.restored(waitingSnapshot), mode: 'practice' })
  waitingSession.reset(); waitingSession.restore(processing.restored(waitingSnapshot)); waitingSession.selectOption(0)
  processing.save(waitingSession); holdProgress = true
  assert.strictEqual((await processing.flush('waiting')).pending, true)
  const pending = processing.queue.get('waiting').pending
  assert(pending.serverAccepted); assert.strictEqual(processing.queue.get('waiting').acknowledgedSequence, 0)
  assert(processing.saveStatus('waiting').saveStatusText.includes('服务器处理中'))
  processing.queue.stop()
  const after202 = new OnlinePractice(storage); after202.identity()
  assert.deepStrictEqual(after202.queue.get('waiting').pending, pending, '202 后重启保留原始命令')
  holdProgress = false
  await flushNow(after202, 'waiting')
  assert.strictEqual(requests.at(-1).method, 'GET')
  assert(requests.at(-1).url.endsWith('/sync-commands/' + pending.idempotencyKey))
  assert.strictEqual(after202.queue.get('waiting').acknowledgedSequence, pending.sequence)
  assert.strictEqual(after202.saveStatus('waiting').saveStatusText, '服务器已保存')
  after202.queue.stop()
  const reviewRuntime = onlinePractice.enable(storage); reviewRuntime.identity()
  reviewRuntime.put('review', Object.assign({}, copy(snapshot), { id: 'review', finishIntent: true, localState: Object.assign({}, runtime.restored(created), { sessionId: 'review', answers: [{ selectedKeys: ['B'], confirmed: true }] }) }))
  const reviewVm = new PracticeViewModel({ storage, repository: { getPreferences: () => ({}), getAuth: value => Object.assign({ loggedIn: true }, value.get('qandaAuth')) } })
  const review = await reviewVm.load({ sessionId: 'review', review: '1' })
  assert.strictEqual(review.data.isViewMode, true)
  assert.strictEqual(review.data.shouldRevealAnswer, true, '即时反馈交卷后可只读回看原选项与答案')
  assert.strictEqual(review.data.answerLocked, true)
  assert.deepStrictEqual(review.data.selectedKeys, ['B'])
  reviewRuntime.put('after-finish', Object.assign({}, copy(snapshot), { id: 'after-finish', feedback: 'AFTER_FINISH', finishIntent: true, route: {} }))
  const blockedVm = new PracticeViewModel({ storage, repository: { getPreferences: () => ({}) } })
  const blocked = await blockedVm.loadOnline({ sessionId: 'after-finish', review: '1' })
  assert.strictEqual(blocked.data.loadError, '批改中，不可进入')
  assert.strictEqual(blockedVm.session, null)
  reviewRuntime.queue.stop()
  const beforeSwitch = requests.length
  storage.set('qandaAuth', { provider: 'email', userId: 'u2', token: 'token2' })
  const denied = await restarted.send('s1', before, 'u1')
  assert.strictEqual(denied.statusCode, 401)
  assert.strictEqual(requests.length, beforeSwitch)
  delete global.wx
  http.configure({ baseUrl: '' })
  console.log('online runtime creation, projection, offline restart, response loss and finish replay passed')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
