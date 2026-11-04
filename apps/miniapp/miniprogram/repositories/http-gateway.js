const transport = require('./api-transport.js')
const { configure, getConfig, request, isConfigured, uuid } = transport

async function identity(response) {
  if (!response.ok) return response
  const session = response.data
  const token = session.accessToken
  if (!token) return { ok: false, reason: '登录信息读取失败，请重试' }
  const me = await request('GET', '/me', {}, { token })
  if (!me.ok) return me
  if (!me.data || !me.data.id) return { ok: false, reason: '登录信息读取失败，请重新登录' }
  return { ok: true, userId: me.data.id, token, email: me.data.email || '', nickname: me.data.nickname, avatarUrl: me.data.avatarUrl || '', version: me.data.version, profile: me.data }
}
function login(code, options) { return request('POST', '/auth/wechat-sessions', { code, deviceId: options && options.deviceId || uuid() }, { token: '' }).then(identity) }
function loginByCode(input) { return request('POST', '/auth/email-code-sessions', input, { token: '' }).then(identity) }
function loginByEmail(email, password, options) { return request('POST', '/auth/sessions', { email, password, deviceId: options && options.deviceId || uuid() }, { token: '' }).then(identity) }
async function sendCode(input) {
  const response = await request('POST', '/auth/email-challenges', { email: input.email, purpose: 'LOGIN' }, { token: '', idempotencyKey: input.idempotencyKey || uuid() })
  return response.ok ? Object.assign({}, response, { challengeId: response.data.id, expiresAt: response.data.expiresAt, cooldown: response.data.resendAfterSeconds }) : response
}
function requestOwnEmailChallenge(input, options) { return request('POST', '/me/email-challenges', input, options) }
function verifyOwnEmailChallenge(id, input, options) { return request('POST', `/me/email-challenges/${encodeURIComponent(id)}/verification`, input, options) }
function changeOwnEmail(input, options) { return request('PUT', '/me/email-binding', input, options) }
function bindOwnWechat(input, options) { return request('PUT', '/me/wechat-binding', input, options) }

module.exports = {
  request,
  uuid,
  getAll: transport.getAll,
  configure,
  getConfig,
  isConfigured,
  login,
  loginByEmail,
  loginByCode,
  name: 'http',
  requestOwnEmailChallenge,
  verifyOwnEmailChallenge,
  changeOwnEmail,
  bindOwnWechat,
  sendCode
}
