const api = require('./api-transport.js')
function parse(value) {
  const parts = String(value || '').trim().split('.')
  if (parts.length !== 2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw new Error('请粘贴管理端提供的完整确认码')
  return { requestId: parts[0], token: parts[1] }
}
async function send(path, body) {
  const response = await api.request('POST', '/content-safety/confirmations' + path, body, { token: '' })
  if (!response.ok) throw new Error(response.reason || '确认失败，请重试')
  return response.data
}
module.exports = {
  parse,
  inspect: value => send('/inspection', parse(value)),
  confirm: (value, code) => send('', Object.assign(parse(value), { code }))
}
