const assert = require('node:assert/strict')
const safety = require('../miniprogram/repositories/content-safety-repository.js')
const confirmation = require('../miniprogram/repositories/content-confirmation-repository.js')
const api = require('../miniprogram/repositories/api-transport.js')
async function main() {
  assert(safety.requiresCheck('PUT', '/me/profile'))
  assert(safety.requiresCheck('POST', '/me/question-feedback'))
  assert(!safety.requiresCheck('POST', '/practice/sessions'))
  const code = '11111111-1111-4111-8111-111111111111.' + 'a'.repeat(43)
  assert.equal(confirmation.parse(code).token, 'a'.repeat(43))
  assert.throws(() => confirmation.parse(code + '.extra'))
  const calls = [], payload = { expectedVersion: 2, nickname: '昵称' }
  let verdict = 'PASSED', token = 'session', issued = 0
  global.wx = { login: input => { issued++; input.success({ code: 'fresh-' + issued }) } }
  api.request = async (method, path, body, options) => {
    calls.push({ method, path, body, options })
    if (options.shouldSend && !options.shouldSend()) return { ok: false, reason: '身份已变化' }
    return { ok: true, data: path.endsWith('/contexts') ? { id: 'context' } : path.endsWith('/requests') ? { id: 'ticket', state: verdict } : { version: 3 } }
  }
  assert.equal((await safety.checkedRequest('PUT', '/me/profile', payload, {}, 'session', () => token)).ok, true)
  assert.equal(issued, 1)
  assert.deepEqual(calls.map(call => call.path), ['/me/content-safety/contexts', '/me/content-safety/requests', '/me/profile'])
  assert.equal(calls[2].options.headers['X-Content-Safety-Request'], 'ticket')
  assert.deepEqual(calls[2].body, payload)
  calls.length = 0; verdict = 'REJECTED'
  assert.equal((await safety.checkedRequest('PUT', '/me/profile', payload, {}, 'session', () => token)).ok, false)
  assert(!calls.some(call => call.path === '/me/profile'), '未通过检测不提交保存')
  calls.length = 0; token = 'other'
  assert.equal((await safety.checkedRequest('PUT', '/me/profile', payload, {}, 'session', () => token)).ok, false)
  assert.equal(calls.length, 0, '旧身份不再发送检测或保存')
  delete global.wx
  console.log('内容检测：邮箱身份独立上下文、相同内容保存、失败阻止与身份切换通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
