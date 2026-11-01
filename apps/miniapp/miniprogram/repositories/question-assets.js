const http = require('./http-gateway.js')
const auth = require('./auth-repository.js')
const pending = new Map()

function validPng(data) {
  const bytes = new Uint8Array(data)
  return bytes.length >= 20 && bytes.length <= 5 * 1024 * 1024 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value) &&
    [73, 69, 78, 68, 174, 66, 96, 130].every((value, i) => bytes[bytes.length - 8 + i] === value)
}

async function load(storage, ids) {
  if (!ids || !ids.length) return []
  const identity = auth.getAuth(storage)
  const owner = identity.userId || 'guest'
  const wxApi = typeof wx !== 'undefined' && wx
  if (!wxApi || !wxApi.getFileSystemManager) throw new Error('当前环境无法保存题目图片')
  const fs = wxApi.getFileSystemManager()
  const current = () => {
    const now = auth.getAuth(storage)
    if ((now.userId || 'guest') !== owner || now.token !== identity.token) throw new Error('账号已切换，请重新打开题目')
  }
  async function one(id) {
    current()
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('题目图片标识无效')
    const path = `${wxApi.env.USER_DATA_PATH}/qanda-image-${encodeURIComponent(owner)}-${id}.png`
    try { if (validPng(fs.readFileSync(path))) return path } catch (error) { /* 下载缺失的附件 */ }
    const response = await http.request('GET', '/files/' + id, null, { token: identity.token || '', responseType: 'arraybuffer' })
    if (!response.ok) throw new Error(response.reason || '题目图片下载失败，请重试')
    current()
    if (!validPng(response.data)) throw new Error('题目图片内容无效')
    const temporary = path + '.partial'
    try {
      await new Promise((resolve, reject) => fs.writeFile({ filePath: temporary, data: response.data, success: resolve, fail: reject }))
      current()
      fs.renameSync(temporary, path)
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch (_) { /* 保留原有完整附件 */ }
      throw new Error('题目图片保存失败，请检查本机空间后重试')
    }
    return path
  }
  const paths = new Array(ids.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++
      const key = `${owner}:${identity.token}:${ids[index]}`
      if (!pending.has(key)) pending.set(key, one(ids[index]).finally(() => pending.delete(key)))
      paths[index] = await pending.get(key)
      current()
    }
  }))
  return paths
}
async function completeSnapshot(storage, snapshot) {
  const ids = [...new Set((snapshot.items || []).flatMap(item => (item.question.assetIds || []).concat(item.question.material && item.question.material.assetIds || [])))]
  const paths = await load(storage, ids)
  const byId = new Map(ids.map((id, index) => [id, paths[index]]))
  for (const item of snapshot.items || []) {
    const question = item.question
    question.imagePaths = (question.assetIds || []).map(id => byId.get(id))
    if (question.material) question.material.imagePaths = (question.material.assetIds || []).map(id => byId.get(id))
  }
  reuseResultImages(snapshot)
  return snapshot
}
function reuseResultImages(snapshot) {
  const byId = new Map((snapshot.items || []).map(item => [item.question.revisionId, item.question]))
  for (const item of snapshot.result && snapshot.result.items || []) {
    const original = byId.get(item.question.revisionId)
    if (!original) continue
    item.question.imagePaths = original.imagePaths || []
    if (item.question.material && original.material && item.question.material.revisionId === original.material.revisionId) item.question.material.imagePaths = original.material.imagePaths || []
  }
}
module.exports = { load, completeSnapshot, validPng, reuseResultImages }
