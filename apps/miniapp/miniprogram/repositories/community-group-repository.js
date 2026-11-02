const api = require('./api-transport.js')

async function load() {
  const response = await api.request('GET', '/community/group', undefined, { token: '' })
  if (!response.ok) throw new Error(response.reason || '群二维码读取失败，请重试')
  const group = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
  if (!group || typeof group.available !== 'boolean') throw new Error('群二维码读取失败，请重试')
  return Object.assign({}, group, { imageUrl: `${api.getConfig().baseUrl}/api/v1/community/group/image?v=${encodeURIComponent(group.version)}` })
}

module.exports = { load }
