const assert = require('node:assert/strict')
const vault = require('../miniprogram/repositories/answer-vault.js')
const { encrypted } = require('./helpers/encrypted-storage.js')
const { createSyncQueue } = require('../miniprogram/repositories/practice-sync-queue.js')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const projection = require('../miniprogram/models/practice-snapshot.js')
const client = require('../miniprogram/models/client-result.js')
const learning = require('../miniprogram/repositories/local-learning.js')
function memory() { const data = {}; return encrypted({ data, get: k => data[k] && JSON.parse(JSON.stringify(data[k])), set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, remove: k => delete data[k], keys: () => Object.keys(data) }) }
function snapshot(count) { return { id: 's', route: {}, version: 1, feedback: 'IMMEDIATE', configuration: {}, items: Array.from({ length: count }, (_, i) => ({ itemId: 'i' + i, position: i, question: { id: 'q' + i, revisionId: 'r' + i, type: 'SINGLE_CHOICE', options: [{ key: 'A', content: '选项' }] } })), offlineGrading: Array.from({ length: count }, (_, i) => ({ itemId: 'i' + i, correctAnswer: ['A'], explanation: '加密解析' })) } }
async function main() {
  const calls = []
  const adapter = require('../miniprogram/utils/wx-storage.js').createWxStorageAdapter({ storage: {
    getAppBaseInfo() { return { SDKVersion: '2.21.3' } },
    getStorageSync() {}, setStorageSync() {}, getStorageInfoSync() { return { keys: [] } },
    setStorage(options) { calls.push(options); options.success({}) },
    getStorage(options) { calls.push(options); options.success({ data: 'ciphertext-roundtrip' }) }
  } })
  await adapter.setEncrypted('key', 'value')
  assert.equal(await adapter.getEncrypted('key'), 'ciphertext-roundtrip')
  assert(calls.every(call => call.encrypt === true))
  const unsupported = require('../miniprogram/utils/wx-storage.js').createWxStorageAdapter({ storage: { getAppBaseInfo() { return { SDKVersion: '2.20.0' } }, setStorage() { throw Error('must not write') } } })
  await assert.rejects(unsupported.setEncrypted('key', 'secret'), /更新微信/)

  const sizes = []
  for (const count of [20, 100, 1000]) {
    const storage = memory(), begun = Date.now()
    const sealed = await vault.seal(storage, snapshot(count))
    storage.set('snapshot', sealed)
    assert(!JSON.stringify(storage.data).includes('加密解析'))
    assert(!JSON.stringify(sealed).includes('correctAnswer'))
    const quiz = projection.quiz(sealed)
    assert(quiz.questions.every(q => !q.answerKeys.length))
    await vault.hydrate(storage, sealed, quiz.questions, [0], () => false)
    assert(!quiz.questions[0].gradingLoaded, '页面已隐藏时丢弃迟到的解密资料')
    await vault.hydrate(storage, sealed, quiz.questions, [0])
    assert.deepEqual(quiz.questions[0].answerKeys, ['A']); assert(!quiz.questions[1].gradingLoaded)
    const bad = { ...sealed.items[0].gradingRef, revisionId: 'wrong' }
    await assert.rejects(vault.read(storage, bad, sealed.items[0].question), /版本/)
    await vault.hydrate(storage, sealed, quiz.questions, quiz.questions.map((_, i) => i))
    const session = new PracticeSession({ quiz, restored: { sessionId: 's' }, mode: 'practice' }); session.reset(); session.selectOption(0); session.forceSubmit()
    const result = client.result(session, sealed)
    assert.equal(result.objective.correct, 1); assert.equal(result.objective.unanswered, count - 1)
    const storedResult = vault.strip({ ...sealed, localResult: result })
    assert.equal(storedResult.localResult.items[0].question, undefined, '成绩只保存题目引用，避免重复整卷内容')
    const restoredResult = vault.restore(storedResult)
    assert.equal(restoredResult.localResult.items[0].question, restoredResult.items[0].question)
    assert.equal(restoredResult.localResult.objective.correct, 1)
    const base = { practiceCount: 1, answerAttemptCount: 1, objectiveAnsweredCount: 1, objectiveCorrectCount: 1, includedSessionIds: ['s'] }
    assert.equal(learning.overview(base, [{ id: 's', localResult: result }]).practiceCount, 1, '丢回执后不重复计数')
    sizes.push({ questions: count, encryptedAndGradedMs: Date.now() - begun, ordinaryBytes: vault.bytes(JSON.stringify(sealed)) })
  }
  const storage = memory()
  const rated = { id: 'rated', localResult: { submittedAt: '2026-11-12T01:00:00Z', items: [{ itemId: 'short', question: { id: 'q-short' }, outcome: 'SELF_RATED', selfAssessment: 'WRONG' }] }, assessmentCommands: { short: { value: 'WRONG', baseAssessment: 'CORRECT' } } }
  const ratingBase = { includedSessionIds: ['rated'], selfRatedCount: 1, selfRatedCorrectCount: 1, selfRatedWrongCount: 0, questionFacts: [{ questionId: 'q-short', judgment: 'SELF_RATED', selfAssessment: 'CORRECT', lastPracticedAt: rated.localResult.submittedAt }] }
  const localRating = learning.overview(ratingBase, [rated])
  assert.equal(localRating.selfRatedCorrectCount, 0); assert.equal(localRating.selfRatedWrongCount, 1)
  assert.equal(learning.facts(ratingBase, [rated]).get('q-short').selfAssessment, 'WRONG')
  const committedRating = { ...ratingBase, selfRatedCorrectCount: 0, selfRatedWrongCount: 1, assessmentFacts: [{ itemId: 'short', selfAssessment: 'WRONG' }] }
  assert.equal(learning.overview(committedRating, [rated]).selfRatedWrongCount, 1, '自评已写入但回执丢失时不重复统计')
  const unratedBase = { ...ratingBase, questionFacts: [{ ...ratingBase.questionFacts[0], selfAssessment: null }] }
  assert(!learning.matchesCollection(learning.collectionRows(unratedBase, [rated], false)[0], { chip: 'subjective' }))
  assert(learning.matchesCollection(learning.collectionRows(unratedBase, [rated], true)[0], { chip: 'subjective' }), '本地首次自评为错时立即增加主观错题')
  const original = snapshot(1); original.offlineGrading[0].explanation = '题'.repeat(400000)
  const large = await vault.seal(storage, original)
  assert(large.items[0].gradingRef.blocks.length > 1)
  assert.equal((await vault.read(storage, large.items[0].gradingRef, large.items[0].question)).explanation.length, 400000)
  const fullStorage = memory(); fullStorage.info = () => ({ currentSize: 7100, limitSize: 10240 })
  await assert.rejects(vault.seal(fullStorage, snapshot(1)), /空间不足/)
  const interrupted = memory(), setEncrypted = interrupted.setEncrypted
  let writes = 0
  interrupted.setEncrypted = async (key, value) => { if (++writes === 2) throw Error('interrupted'); return setEncrypted(key, value) }
  await assert.rejects(vault.seal(interrupted, original), /interrupted/)
  assert(!Object.keys(interrupted.data).some(key => key.startsWith(vault.PREFIX)), '中断写入不遗留未发布答案块')
  await assert.rejects(vault.seal({ get: () => null }, snapshot(1)), /加密/)
  let now = 0, sends = 0, reply = { ok: false, statusCode: 503, retryAfter: 12000 }
  const options = { storage, userId: 'u', now: () => now, random: () => 0, setTimer: () => 1, clearTimer() {}, send: async () => { sends++; return reply } }
  const queue = createSyncQueue(options)
  queue.save('one', { progress: { items: [{ itemId: 'i', answer: 1 }] } })
  now = 30000; queue.save('one', { progress: { items: [{ itemId: 'i', answer: 2 }] } })
  await queue.flushAll(); assert.equal(sends, 0)
  now = 60000; await queue.flushAll(); assert.equal(sends, 1)
  queue.save('two', { progress: { items: [] } }); await queue.finish('two', { progress: { items: [] } }); await queue.flush('two'); assert.equal(sends, 1, '账号共享繁忙退避')
  queue.stop()
  const restarted = createSyncQueue(options); await restarted.flush('two'); assert.equal(sends, 1, '重启不绕过冷却')
  now += 12001; reply = { ok: true }; await restarted.flush('two'); assert.equal(sends, 2)
  assert(restarted.get('two').finished)
  restarted.stop()
  console.log('本地结果、加密分块、修订配对、统计去重与共享退避检查通过', JSON.stringify(sizes))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
