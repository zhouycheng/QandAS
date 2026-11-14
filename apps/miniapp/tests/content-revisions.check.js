const assert = require('node:assert/strict')
const api = require('../miniprogram/repositories/api-transport.js')
const revisions = require('../miniprogram/repositories/content-revisions.js')
const vault = require('../miniprogram/repositories/answer-vault.js')
const { encrypted } = require('./helpers/encrypted-storage.js')
async function main() {
  const data = {}, storage = encrypted({ get: k => data[k] && JSON.parse(JSON.stringify(data[k])), set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, remove: k => delete data[k], keys: () => Object.keys(data) })
  const question = (revisionId, key) => ({ id: 'q', revisionId, questionBankId: 'bank', type: 'SINGLE_CHOICE', stem: '题干' + revisionId, options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }], correctAnswer: [key], explanation: '解析' + revisionId, assetIds: [] })
  const a = await vault.seal(storage, { id: 'practice', items: [{ itemId: 'i', question: question('A', 'A') }] })
  storage.set('qandaTrialPractice', { version: 1, usedCount: 1, sessions: [a] }); vault.publish(a)
  let reads = 0
  const original = api.request
  api.request = async (method, path, query) => {
    if (path === '/content/revision-status') return { ok: true, data: [{ questionId: 'q', revisionId: 'B', contentVersion: 2, available: true, changed: true }] }
    assert.equal(query && query.includeAnswers, true, '单题下载显式请求配套答案')
    reads++; return { ok: true, data: question('B', 'B') }
  }
  const updates = await revisions.check(storage, a)
  assert.equal(updates[0].revisionId, 'B')
  assert.deepEqual((await vault.read(storage, a.items[0].gradingRef, a.items[0].question)).correctAnswer, ['A'])
  const latest = await revisions.latest(storage, 'q')
  assert.equal(latest.items[0].question.stem, '题干B')
  assert.deepEqual((await vault.read(storage, latest.items[0].gradingRef, latest.items[0].question)).correctAnswer, ['B'])
  await revisions.check(storage, a); assert.equal(reads, 1, '同一范围五分钟内合并检查与下载')
  const bad = { ...latest.items[0].question, material: { revisionId: 'different' } }
  await assert.rejects(vault.read(storage, latest.items[0].gradingRef, bad), /版本/)
  assert(!JSON.stringify(data).includes('解析A')); assert(!JSON.stringify(data).includes('解析B'))
  const before = storage.get('qandaContentLatest:guest:q')
  const write = storage.setEncrypted
  storage.setEncrypted = async () => { throw Error('full') }
  await assert.rejects(revisions.download(storage, 'q'), /full|保存失败/)
  assert.deepEqual(storage.get('qandaContentLatest:guest:q'), before, '下载失败保留完整的已发布内容')
  storage.setEncrypted = write
  for (const change of ['answer', 'explanation', 'options', 'material', 'unavailable', 'duringDownload', 'downloadFailure']) {
    const id = 'q-' + change
    const base = { ...question('A', 'A'), id, material: { id: 'm-' + change, revisionId: 'MA', passage: '原阅读材料', assetIds: [] } }
    const next = { ...base, revisionId: change === 'material' ? 'A' : 'B' }
    if (change === 'answer') next.correctAnswer = ['B']
    if (change === 'explanation') next.explanation = '更新解析'
    if (change === 'options') next.options = [{ key: 'A', content: '新选项甲' }, { key: 'B', content: '新选项乙' }]
    if (change === 'material') next.material = { ...base.material, revisionId: 'MB', passage: '新阅读材料' }
    let current = base, busy = change === 'downloadFailure'
    api.request = async (method, path) => path === '/content/revision-status'
      ? { ok: true, data: [{ questionId: id, revisionId: next.revisionId, materialRevisionId: next.material.revisionId, contentVersion: 2, available: change !== 'unavailable', changed: true }] }
      : change === 'unavailable' && current !== base ? { ok: false, statusCode: 404, reason: '题目已下架' }
        : busy && current !== base ? { ok: false, statusCode: 503, reason: '暂忙' } : { ok: true, data: current }
    const pinned = await revisions.download(storage, id)
    current = change === 'duringDownload' ? { ...next, revisionId: 'C', explanation: '下载时再次更新的解析' } : next
    await revisions.check(storage, pinned)
    if (busy) { assert.equal(storage.get('qandaContentLatest:guest:' + id).checkedAt, 0, '下载失败不能把旧内容当作新版'); busy = false }
    assert.equal(pinned.items[0].question.revisionId, 'A', change + ' 保留原题目')
    const savedAnswer = await vault.read(storage, pinned.items[0].gradingRef, pinned.items[0].question)
    assert.deepEqual(savedAnswer.correctAnswer, ['A']); assert.equal(savedAnswer.explanation, '解析A')
    if (change === 'unavailable') {
      await assert.rejects(revisions.latest(storage, id), /下架/)
    } else {
      const updated = await revisions.latest(storage, id), item = updated.items[0]
      assert.equal(item.question.revisionId, current.revisionId)
      assert.equal(item.question.material.revisionId, current.material.revisionId)
      const answer = await vault.read(storage, item.gradingRef, item.question)
      assert.deepEqual(answer.correctAnswer, current.correctAnswer); assert.equal(answer.explanation, current.explanation)
      assert.deepEqual(item.question.options, current.options)
    }
  }
  api.request = original
  console.log('A/B 修订隔离、配套答案、新版原子发布、失败保留与低频检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
