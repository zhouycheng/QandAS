const assert = require('node:assert/strict')
const http = require('../miniprogram/repositories/http-gateway.js')
const online = require('../miniprogram/repositories/online-practice.js')
const vault = require('../miniprogram/repositories/answer-vault.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const { encrypted } = require('./helpers/encrypted-storage.js')
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
async function main() {
  const data = { qandaAuth: { provider: 'email', userId: 'u1', token: 'token1' }, qandaDeviceId: 'device1' }
  let full = false, offline = false, lostCreate = true, lostFinish = true, version = 1
  const storage = encrypted({ get: k => copy(data[k]), set: (k, v) => { if (full) throw Error('full'); data[k] = copy(v) }, remove: k => delete data[k], keys: () => Object.keys(data) })
  const writer = { deviceId: 'device1', writerToken: 'writer1', acknowledgedSequence: 0, version: 1 }
  const snapshot = { id: 's1', questionBankId: 'b1', version: 1, status: 'IN_PROGRESS', feedback: 'IMMEDIATE', currentIndex: 0, durationSeconds: 0,
    writer, configuration: { count: 2, mode: 'practice', chapterIds: [], feedback: 'IMMEDIATE', contentVersion: 1 },
    items: ['SINGLE_CHOICE', 'SHORT_ANSWER'].map((type, i) => ({ itemId: 'i' + i, position: i, question: { id: 'q' + i, revisionId: 'r' + i, type, options: type === 'SINGLE_CHOICE' ? [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }] : [], assetIds: [] } })),
    offlineGrading: [{ itemId: 'i0', correctAnswer: ['A'], explanation: '仅答后展示的解析' }, { itemId: 'i1', referenceAnswer: '简答参考内容', explanation: '简答解析' }] }
  const requests = [], commands = new Map(), original = http.request
  http.request = async (method, path, body, settings = {}) => {
    requests.push({ method, path, body: copy(body), settings, offline })
    if (offline) return { ok: false, statusCode: 0, reason: '网络暂不可用' }
    if (path === '/question-banks/b1') return { ok: true, data: { id: 'b1', contentVersion: 1, questionCount: 2, name: '练习题库' } }
    if (path === '/practice/sessions') {
      if (lostCreate) { lostCreate = false; return { ok: false, statusCode: 0, reason: '请求超时' } }
      return { ok: true, data: copy(snapshot) }
    }
    if (path.endsWith('/sync-commands') && method === 'POST') {
      const key = settings.idempotencyKey
      if (!commands.has(key)) commands.set(key, { state: 'COMMITTED', acknowledgement: { id: 's1', version: ++version, acknowledgedSequence: body.clientSequence, writer: { ...writer, version } }, resultId: body.kind === 'FINISH' ? 'result1' : null, result: null })
      if (body.kind === 'FINISH' && lostFinish) { lostFinish = false; return { ok: false, statusCode: 0, reason: '请求超时' } }
      return { ok: true, data: copy(commands.get(key)) }
    }
    if (method === 'GET' && path.includes('/sync-commands/')) return commands.has(path.split('/').pop()) ? { ok: true, data: copy(commands.get(path.split('/').pop())) } : { ok: false, statusCode: 404 }
    if (path.endsWith('/self-assessment')) return { ok: true, data: { version: ++version } }
    throw Error('Unexpected request ' + path)
  }
  const runtime = online.enable(storage)
  await assert.rejects(runtime.prepare({ bankId: 'b1', mode: 'practice' }), /超时/)
  const saved = await runtime.prepare({ bankId: 'b1', mode: 'practice' })
  const creations = requests.filter(r => r.path === '/practice/sessions')
  assert.equal(creations[0].settings.idempotencyKey, creations[1].settings.idempotencyKey)
  assert.deepEqual(creations[0].body, creations[1].body)
  assert(!JSON.stringify(data).includes('仅答后展示的解析'))
  const quiz = runtime.quiz(saved)
  await vault.hydrate(storage, saved, quiz.questions, [0, 1])
  const session = new PracticeSession({ quiz, restored: { sessionId: 's1' }, mode: 'practice', feedback: 'IMMEDIATE' })
  session.reset(); session.selectOption(1)
  assert.equal(session.state.answers[0].isCorrect, false)
  session.showQuestionAtIndex(1); session.setAnswerText('我的简答'); runtime.save(session)
  const flush = async current => {
    storage.remove('qandaSyncCooldown:v1:u1')
    const draft = current.queue.get('s1'); if (draft) { draft.nextAttemptAt = 0; storage.set('qandaSync:v1:u1:s1', draft) }
    return current.flush('s1')
  }
  await flush(runtime)
  full = true; assert.throws(() => runtime.save(session), /full/); full = false
  assert.equal(runtime.saveStatus('s1').saveStatusText, '本次作答未能保存，请释放空间后重试')
  offline = true; session.finish()
  full = true
  await assert.rejects(runtime.finish(session), /保存失败|空间/)
  assert(!runtime.get('s1').localResult, '本地交卷写入失败不能发布完成结果')
  full = false
  const localResult = await runtime.finish(session)
  assert.equal(localResult.objective.wrong, 1)
  assert.equal(runtime.get('s1').localResult.objective.wrong, 1)
  assert(!JSON.stringify(data).includes('简答参考内容'))
  delete data['qandaOnline:u1:s1'].localResult
  assert.equal(runtime.get('s1').localResult.submittedAt, localResult.submittedAt, '完整交卷日志恢复未成功写入的摘要')
  runtime.queue.stop()
  const recovered = online.enable(storage)
  const vm = new PracticeViewModel({ storage })
  const restored = await vm.load({ sessionId: 's1' })
  assert.equal(restored.data.isCompleted, true)
  assert.equal(vm.session.state.score, 0)
  assert.equal(restored.command, undefined)
  offline = false
  await flush(recovered)
  await flush(recovered)
  assert.equal(recovered.get('s1').cloudConfirmed, true)
  assert.equal(recovered.get('s1').localResult.objective.wrong, 1)
  const finishes = requests.filter(r => !r.offline && r.method === 'POST' && r.body && r.body.kind === 'FINISH')
  assert.equal(finishes.length, 1, '丢响应后读取原回执，不重传交卷')
  assert.equal(finishes[0].body.items[0].outcome, 'WRONG')
  assert.equal(finishes[0].body.items[0].revisionId, 'r0')
  assert.equal(finishes[0].body.submittedAt, localResult.submittedAt, '离线交卷保留实际完成时间')
  assert(!JSON.stringify(finishes[0].body).includes('explanation'))
  offline = true
  const rated = await recovered.assess('s1', 'i1', 'CORRECT')
  assert.equal(rated.shortAnswer.correct, 1)
  assert(recovered.get('s1').assessmentCommands.i1)
  offline = false; storage.remove('qandaSyncCooldown:v1:u1'); await recovered.replayAssessments('s1')
  assert(!recovered.get('s1').assessmentCommands.i1)
  storage.set('qandaAuth', { provider: 'email', userId: 'u2', token: 'token2' })
  recovered.identity()
  assert.equal((await recovered.send('s1', { sequence: 3 }, 'u1')).statusCode, 401)
  recovered.queue.stop(); http.request = original
  console.log('加密快照、本地交卷、丢响应恢复、自评补传及账号隔离检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
