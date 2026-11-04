const api = require('./api-transport.js')
function requiresCheck(method, path) {
  return method === 'PUT' && path === '/me/profile' || method === 'POST' && ['/me/question-feedback', '/me/course-requests'].includes(path)
}
async function checkedRequest(method, path, payload, options, token, currentToken) {
  const identity = () => token && currentToken() === token && (!options.shouldSend || options.shouldSend())
  const send = (verb, route, body, extra) => api.request(verb, route, body, Object.assign({ token, shouldSend: identity }, extra))
  const check = response => { if (!response.ok) throw Object.assign(new Error(response.reason), response); return response.data }
  try {
    const code = await require('./auth-repository.js').requestWechatCode()
    if (!identity()) throw new Error('账号已切换，请重新提交')
    const context = check(await send('POST', '/me/content-safety/contexts', { code }))
    const ticket = check(await send('POST', '/me/content-safety/requests', { method, path, payload, contextId: context.id }))
    let state = ticket
    while (['CHECKING', 'RUNNING', 'PENDING'].includes(state.state)) {
      if (!identity()) throw new Error('账号已切换，请重新提交')
      await new Promise(resolve => setTimeout(resolve, 1000))
      state = check(await send('GET', '/me/content-safety/requests/' + encodeURIComponent(ticket.id)))
    }
    if (state.state !== 'PASSED') throw new Error(state.state === 'EXPIRED' ? '内容检查已超时，请重试' : '内容未通过检查，请修改或重试')
    if (!identity()) throw new Error('账号已切换，请重新提交')
    return send(method, path, payload, Object.assign({}, options, { headers: Object.assign({}, options.headers, { 'X-Content-Safety-Request': ticket.id }) }))
  } catch (error) { return { ok: false, statusCode: error.statusCode || 0, code: error.code || '', reason: error.message || '内容检查失败，请重试' } }
}
module.exports = { requiresCheck, checkedRequest }
