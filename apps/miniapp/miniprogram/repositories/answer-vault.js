const copy = value => JSON.parse(JSON.stringify(value))
const fields = ['correctAnswer', 'correctValue', 'referenceAnswer', 'explanation', 'blanks', 'blankMatch', 'scoringPoints']
const PREFIX = 'qandaAnswer:v1:'
const MAX_BYTES = 256 * 1024
const bytes = text => { let n = 0; for (const c of text) { const p = c.codePointAt(0); n += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4 } return n }
function split(text) {
  const result = []; let part = '', size = 0
  for (const c of text) {
    const n = bytes(c)
    if (size + n > MAX_BYTES) { result.push(part); part = ''; size = 0 }
    part += c; size += n
  }
  if (part) result.push(part)
  return result
}
function identity(q) { return { questionId: q.id, revisionId: q.revisionId, materialRevisionId: q.material && q.material.revisionId || null } }
function stripQuestion(q) { fields.forEach(key => { delete q[key] }); (q.subQuestions || []).forEach(stripQuestion) }
function strip(snapshot) {
  const result = copy(snapshot)
  delete result.offlineGrading
  for (const list of [result.items, result.result && result.result.items, result.localResult && result.localResult.items]) for (const item of list || []) if (item.question) stripQuestion(item.question)
  for (const list of [result.result && result.result.items, result.localResult && result.localResult.items]) for (const item of list || []) { delete item.question; delete item.gradingRef }
  return result
}
function restore(snapshot) {
  if (!snapshot || !snapshot.result && !snapshot.localResult) return snapshot
  const items = new Map((snapshot.items || []).map(item => [item.itemId, item]))
  for (const list of [snapshot.result && snapshot.result.items, snapshot.localResult && snapshot.localResult.items]) for (const item of list || []) {
    const source = items.get(item.itemId)
    if (!source) throw new Error('练习内容不完整，作答记录已保留，请重新打开')
    item.question = source.question; item.gradingRef = source.gradingRef
  }
  return snapshot
}
function owner(storage) { const auth = storage.get('qandaAuth') || {}; return auth.userId || 'guest' }
function guard(storage, expected) { if (owner(storage) !== expected) throw new Error('账号已切换，请重新打开练习') }
async function write(storage, q, grading, expectedOwner = owner(storage)) {
  if (!storage.setEncrypted || !storage.getEncrypted) throw new Error('当前环境无法加密保存答案，请更新微信后重试')
  const activeOwner = owner(storage)
  const ref = identity(q)
  if (!ref.questionId || !ref.revisionId) throw new Error('题目版本不完整，请重新下载')
  const value = { format: 1, ...ref }
  const valid = ['SINGLE_CHOICE', 'MULTIPLE_CHOICE'].includes(q.type) ? Array.isArray(grading.correctAnswer) && grading.correctAnswer.length && grading.correctAnswer.every(key => (q.options || []).some(option => option.key === key))
    : q.type === 'TRUE_FALSE' ? typeof grading.correctValue === 'boolean'
      : q.type === 'FILL_BLANK' ? Array.isArray(grading.blanks) && grading.blanks.length === q.blankCount && grading.blanks.every(blank => Array.isArray(blank.answers) && blank.answers.length)
        : q.type === 'SHORT_ANSWER' ? typeof grading.referenceAnswer === 'string' : true
  if (!valid) throw new Error('答案资料下载不完整，请重新读取本次练习')
  fields.forEach(key => { if (grading[key] !== undefined) value[key] = grading[key] })
  const parts = split(JSON.stringify(value))
  if (storage.info) {
    const info = storage.info()
    if (Number(info.currentSize) + parts.reduce((n, p) => n + bytes(p) * 1.4 / 1024, 0) > Math.min(Number(info.limitSize) || 10240, 7100)) throw new Error('本机空间不足，请释放空间后重试')
  }
  // A generation is published only after every encrypted block has been read back.
  const generation = require('./api-transport.js').uuid()
  const blocks = parts.map((_, i) => `${PREFIX}${expectedOwner}:${ref.revisionId}:${generation}:${i}`)
  blocks.forEach(key => staged.add(key))
  try {
    for (let i = 0; i < parts.length; i++) {
      guard(storage, activeOwner)
      await storage.setEncrypted(blocks[i], parts[i])
      if (await storage.getEncrypted(blocks[i]) !== parts[i]) throw new Error('答案资料保存不完整')
      guard(storage, activeOwner)
    }
  } catch (error) { blocks.forEach(key => { staged.delete(key); try { storage.remove(key) } catch (_) {} }); throw new Error(error.message || '答案保存失败，请检查本机空间后重试') }
  return { format: 1, owner: expectedOwner, ...ref, blocks }
}
async function read(storage, ref, q) {
  const expected = identity(q)
  if (!ref || ref.format !== 1 || (ref.owner !== 'guest' && ref.owner !== owner(storage)) || Object.keys(expected).some(key => (ref[key] || null) !== (expected[key] || null)) || !Array.isArray(ref.blocks) || !ref.blocks.length || !storage.getEncrypted) throw new Error('题目与答案版本不一致，请重新读取本次练习')
  const activeOwner = owner(storage)
  guard(storage, activeOwner)
  try {
    const parts = []
    for (const block of ref.blocks) {
      if (!block.startsWith(`${PREFIX}${ref.owner}:`)) throw new Error('invalid block')
      parts.push(await storage.getEncrypted(block)); guard(storage, activeOwner)
    }
    const value = JSON.parse(parts.join(''))
    if (value.format !== 1 || Object.keys(expected).some(key => (value[key] || null) !== (expected[key] || null))) throw new Error('invalid revision')
    return value
  } catch (_) { throw new Error('答案资料暂时无法读取，作答记录已保留，请联网重新读取本次练习') }
}
async function seal(storage, snapshot, keyOwner = owner(storage)) {
  const result = strip(snapshot), expectedOwner = owner(storage)
  const grading = new Map((snapshot.offlineGrading || []).map(g => [g.itemId, g]))
  const source = new Map((snapshot.items || []).map(item => [item.itemId, item]))
  for (const item of snapshot.result && snapshot.result.items || []) if (!grading.has(item.itemId)) grading.set(item.itemId, item.question)
  try {
  const references = new Map()
  for (const item of result.items || []) {
    const original = source.get(item.itemId)
    if (!item.gradingRef) {
      const value = grading.get(item.itemId) || original.question
      if (value.questionId && value.questionId !== item.question.id || value.revisionId && value.revisionId !== item.question.revisionId || Object.prototype.hasOwnProperty.call(value, 'materialRevisionId') && (value.materialRevisionId || null) !== (item.question.material && item.question.material.revisionId || null)) throw new Error('题目与答案版本不一致，请重新下载')
      item.gradingRef = await write(storage, item.question, value, keyOwner)
    }
    references.set(item.itemId, item.gradingRef)
  }
  for (const list of [result.result && result.result.items, result.localResult && result.localResult.items]) for (const item of list || []) item.gradingRef = references.get(item.itemId)
  guard(storage, expectedOwner)
  return restore(result)
  } catch (error) { discard(result, storage); throw error }
}
async function hydrate(storage, snapshot, questions, indexes, active = () => true) {
  const items = snapshot.items || []
  for (const index of indexes) {
    const question = questions[index], item = items.find(i => i.itemId === question.itemId)
    if (!item || !item.gradingRef || question.gradingLoaded) continue
    const value = await read(storage, item.gradingRef, item.question)
    if (!active()) return
    const mapped = require('../models/practice-snapshot.js').mapQuestion(item, value)
    Object.assign(question, mapped, { gradingLoaded: true })
  }
}
function release(questions) {
  for (const q of questions || []) { q.answerKeys = []; q.blanks = Array.from({ length: q.blankCount || 0 }, () => ({ answers: [] })); q.blankMatch = {}; q.referenceAnswer = ''; q.explanation = ''; q.scoringPoints = []; delete q.gradingLoaded }
}
module.exports = { seal, strip, restore, read, write, hydrate, release, stripQuestion, split, bytes, PREFIX }

function referenced(value, keys) {
  if (!value || typeof value !== 'object') return
  if (value.gradingRef && Array.isArray(value.gradingRef.blocks)) value.gradingRef.blocks.forEach(key => keys.add(key))
  for (const key of Object.keys(value)) if (key !== 'gradingRef' && value[key] && typeof value[key] === 'object') referenced(value[key], keys)
}
function collect(storage) {
  if (!storage.keysStrict && !storage.keys) return
  try {
    const all = storage.keysStrict ? storage.keysStrict() : storage.keys(), expected = owner(storage), used = new Set()
    for (const key of all) if (key.startsWith(`qandaOnline:${expected}:`) && !key.includes(':wire:') || key.startsWith(`qandaContent:${expected}:`) || key === 'qandaTrialPractice') referenced(storage.get(key), used)
    for (const key of all) if (key.startsWith(`${PREFIX}${expected}:`) && !used.has(key) && !staged.has(key)) storage.remove(key)
  } catch (_) { /* A failed inventory must never delete an unreadable reference. */ }
}
const staged = new Set()
function publish(snapshot) { const keys = new Set(); referenced(snapshot, keys); keys.forEach(key => staged.delete(key)) }
module.exports.collect = collect
module.exports.publish = publish

function discard(snapshot, storage) {
  const keys = new Set(); referenced(snapshot, keys)
  keys.forEach(key => { if (staged.has(key)) { try { storage.remove(key); staged.delete(key) } catch (_) {} } })
}
module.exports.discard = discard
