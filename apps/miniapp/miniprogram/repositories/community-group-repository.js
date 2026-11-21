const api = require('./api-transport.js')
const { validPng } = require('../utils/valid-png.js')
const pending = new Map()

function failure(stage, message) {
  console.warn('[community-group]', stage, message)
  return Object.assign(new Error(message), { stage })
}

function decodable(path) {
  return new Promise(resolve => wx.getImageInfo({ src: path, success: () => resolve(true), fail: () => resolve(false) }))
}

async function localImage(version) {
  const fs = wx.getFileSystemManager()
  const directory = wx.env.USER_DATA_PATH
  const prefix = 'qanda-group-' + encodeURIComponent(api.getConfig().baseUrl) + '-'
  const path = directory + '/' + prefix + version + '.png'
  if (await decodable(path)) return path

  const response = await api.request('GET', '/community/group/image?v=' + version, undefined, { token: '', responseType: 'arraybuffer' })
  if (!response.ok) throw failure('image-request', response.reason || '群二维码读取失败，请重试')
  if (!validPng(response.data)) throw failure('image-validation', '群二维码格式无效，请重试')
  const temporary = path + '.partial.png'
  try {
    await new Promise((resolve, reject) => fs.writeFile({ filePath: temporary, data: response.data, success: resolve, fail: reject }))
    if (!await decodable(temporary)) throw failure('image-validation', '群二维码无法显示，请重试')
    fs.renameSync(temporary, path)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch (_) { /* 文件可能尚未写入 */ }
    if (error && error.stage) throw error
    throw failure('image-storage', '群二维码保存失败，请检查本机空间后重试')
  }
  try {
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith(prefix) && /^\d+\.png$/.test(name.slice(prefix.length)) && Number(name.slice(prefix.length, -4)) < version) fs.unlinkSync(directory + '/' + name)
    }
  } catch (_) { /* 旧文件可在下次换码时清理 */ }
  return path
}

async function load() {
  const response = await api.request('GET', '/community/group', undefined, { token: '' })
  if (!response.ok) throw failure('status-request', response.reason || '群二维码状态读取失败，请重试')
  let group
  try { group = typeof response.data === 'string' ? JSON.parse(response.data) : response.data } catch (_) { /* 校验状态响应 */ }
  if (!group || typeof group.available !== 'boolean' || !Number.isSafeInteger(group.version) || group.version < 0) throw failure('status-response', '群二维码状态无效，请重试')
  if (!group.available || !(Date.parse(group.expiresAt) > Date.now())) return { ...group, imageUrl: '' }
  const key = api.getConfig().baseUrl + '/' + group.version
  if (!pending.has(key)) pending.set(key, localImage(group.version).finally(() => pending.delete(key)))
  const imageUrl = await pending.get(key)
  return { ...group, imageUrl }
}

module.exports = { load }
