const assert = require('node:assert/strict')
const assets = require('../miniprogram/repositories/question-assets.js')
const http = require('../miniprogram/repositories/http-gateway.js')
const { buildEmailAuth } = require('../miniprogram/utils/auth-session.js')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const data = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,73,69,78,68,174,66,96,130]).buffer
async function run() {
  let identity = buildEmailAuth({ userId: 'a', token: 'a', email: 'a@example.test' })
  const storage = { get: () => identity }
  const files = new Map()
  let failWrite = false, active = 0, peak = 0, requests = 0
  global.wx = { env: { USER_DATA_PATH: '/local' }, getFileSystemManager: () => ({
    readFileSync(path) { if (!files.has(path)) throw new Error('missing'); return files.get(path) },
    writeFile(options) { if (failWrite) return options.fail(); files.set(options.filePath, options.data); options.success() },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from) },
    unlinkSync(path) { files.delete(path) }
  }) }
  const original = http.request
  http.request = async () => { requests++; active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return { ok: true, data } }
  try {
    const snapshot = { items: Array.from({ length: 9 }, (_, i) => ({ question: { assetIds: [id(i)], material: { assetIds: [id(0)] } } })) }
    await assets.completeSnapshot(storage, snapshot)
    assert.equal(requests, 9); assert.equal(peak, 4)
    assert.equal(snapshot.items[0].question.imagePaths[0], snapshot.items[8].question.material.imagePaths[0])
    await assets.completeSnapshot(storage, snapshot); assert.equal(requests, 9, '完整缓存支持断网续答')
    snapshot.items[0].question.revisionId = 'revision-a'
    snapshot.items[0].question.material.revisionId = 'material-a'
    snapshot.result = { items: [{ question: { revisionId: 'revision-a', material: { revisionId: 'material-a' } } }, { question: { revisionId: 'different' } }] }
    assets.reuseResultImages(snapshot)
    assert.deepEqual(snapshot.result.items[0].question.imagePaths, snapshot.items[0].question.imagePaths)
    assert.deepEqual(snapshot.result.items[0].question.material.imagePaths, snapshot.items[0].question.material.imagePaths)
    assert.equal(snapshot.result.items[1].question.imagePaths, undefined, '只复用同一修订的结果附件')
    assert.equal([...files.keys()].some(key => key.endsWith('.partial')), false)
    failWrite = true
    await assert.rejects(assets.load(storage, [id(20)]), /保存失败/)
    assert.equal([...files.keys()].some(key => key.includes(id(20))), false)
    failWrite = false
    const pending = assets.load(storage, [id(21)])
    identity = buildEmailAuth({ userId: 'b', token: 'b', email: 'b@example.test' })
    await assert.rejects(pending, /账号已切换/)
    assert.equal(assets.validPng(new Uint8Array([137,80,78,71]).buffer), false)
    await assert.rejects(assets.load(storage, ['../escape']), /暂时无法读取题目图片/)
    console.log('question images: bounded downloads, deduplication, offline cache, atomic storage and identity isolation passed')
  } finally { http.request = original; delete global.wx }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
