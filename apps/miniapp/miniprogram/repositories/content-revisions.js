const http = require('./api-transport.js')
const auth = require('./auth-repository.js')
const vault = require('./answer-vault.js')
const assets = require('./question-assets.js')
const checks = new Map()
const owner = storage => auth.getAuth(storage).userId || 'guest'
const revisionKey = q => `${q.id}:${q.revisionId}:${q.material && q.material.revisionId || ''}`
function keys(storage, id) { return { latest: `qandaContentLatest:${owner(storage)}:${id}`, prefix: `qandaContent:${owner(storage)}:` } }
async function download(storage, id) {
  const expected = owner(storage)
  const response = await http.request('GET', `/questions/${encodeURIComponent(id)}`, { includeAnswers: true }, { priority: 'background' })
  if (!response.ok) throw new Error(response.reason || '题目暂时无法读取')
  if (owner(storage) !== expected) throw new Error('账号已切换，请重新打开题目')
  const original = { id, items: [{ itemId: id, question: response.data }] }
  await assets.completeSnapshot(storage, original)
  const snapshot = await vault.seal(storage, original)
  if (owner(storage) !== expected) throw new Error('账号已切换，请重新打开题目')
  const key = keys(storage, id), versioned = key.prefix + revisionKey(response.data)
  try { storage.set(versioned, snapshot) } catch (error) { vault.discard(snapshot, storage); throw error }
  vault.publish(snapshot)
  storage.set(key.latest, { key: versioned, checkedAt: Date.now() })
  return snapshot
}
async function latest(storage, id) {
  const key = keys(storage, id), pointer = storage.get(key.latest)
  if (pointer && Date.now() - pointer.checkedAt < 300000) {
    const saved = storage.get(pointer.key)
    if (saved) return saved
  }
  return download(storage, id)
}
async function check(storage, snapshot) {
  const expected = owner(storage)
  const refs = (snapshot.items || []).map(i => ({ questionId: i.question.id, revisionId: i.question.revisionId, materialRevisionId: i.question.material && i.question.material.revisionId || null }))
  const unique = Array.from(new Map(refs.map(ref => [JSON.stringify(ref), ref])).values())
  const key = expected + ':' + JSON.stringify(unique)
  const old = checks.get(key)
  if (old && Date.now() - old.at < 300000) return old.promise
  const promise = (async () => {
    const rows = []
    for (let i = 0; i < unique.length; i += 100) {
      const response = await http.request('POST', '/content/revision-status', { items: unique.slice(i, i + 100) }, { priority: 'background' })
      if (!response.ok || owner(storage) !== expected) throw new Error(response.reason || '题目更新检查暂不可用')
      rows.push(...response.data)
    }
    const updates = rows.filter(row => row.changed)
    for (const row of updates.filter(row => !row.available)) storage.remove(keys(storage, row.questionId).latest)
    for (const row of updates.filter(row => row.available)) {
      const key = keys(storage, row.questionId).latest, previous = storage.get(key)
      if (previous) storage.set(key, { ...previous, checkedAt: 0 })
    }
    for (const row of updates.filter(row => row.available)) {
      if (owner(storage) !== expected) throw new Error('账号已切换')
      try { await download(storage, row.questionId) } catch (_) { break }
    }
    return updates
  })()
  checks.set(key, { at: Date.now(), promise })
  promise.catch(() => { if (checks.get(key) && checks.get(key).promise === promise) checks.delete(key) })
  return promise
}
function clear() { checks.clear() }
module.exports = { latest, download, check, clear, revisionKey }
