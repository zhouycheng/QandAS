const assert = require('node:assert/strict')
const { AccountDeletionRepository, resumeCleanup } = require('../miniprogram/repositories/account-deletion-repository.js')
const { createSyncQueue } = require('../miniprogram/repositories/practice-sync-queue.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const api = require('../miniprogram/repositories/api-transport.js')
async function main() {
  const id = '11111111-1111-4111-8111-111111111111', values = {}, calls = []
  let failEnumeration = true
  const storage = { get: key => values[key], set: (key, value) => { values[key] = value }, remove: key => delete values[key], keysStrict() { if (failEnumeration) { failEnumeration = false; throw new Error('读取存储失败') } return Object.keys(values) } }
  auth.saveAuth(storage, { provider: 'email', userId: id, token: 'session', email: 'learner@example.test' })
  values['qandaOnline:' + id + ':practice'] = { private: true }
  values['qandaOnline:other:practice'] = { retained: true }
  values.qandaCatalogFilters = { grade: 2 }
  api.request = async (method, path, body, options) => {
    calls.push({ method, path, body, options })
    return { ok: true, data: path === '/me/deletion-confirmations' ? { proof: 'x'.repeat(43) } : method === 'GET' ? { email: 'learner@example.test' } : { completed: true } }
  }
  const repository = new AccountDeletionRepository(storage)
  assert.equal((await repository.load()).method, 'EMAIL')
  await repository.issue(); await repository.verify('123456')
  await assert.rejects(repository.erase(), /读取存储失败/)
  assert(values['qandaErasedAccount:' + id])
  assert(!JSON.stringify(values).includes('123456') && !JSON.stringify(values).includes('x'.repeat(43)))
  await repository.erase()
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1, '本机清理重试不重新注销')
  const deletion = calls.find(call => call.method === 'DELETE')
  assert.equal(deletion.options.token, '')
  assert(deletion.options.idempotencyKey)
  assert.equal(values['qandaOnline:' + id + ':practice'], undefined)
  assert(values['qandaOnline:other:practice'] && values.qandaCatalogFilters)
  assert.equal(auth.getAuth(storage).loggedIn, false)
  values['qandaErasedAccount:' + id] = { email: '' }
  resumeCleanup(storage)
  assert.equal(values['qandaErasedAccount:' + id], undefined)
  let finish
  const queue = createSyncQueue({ storage, userId: id, setTimer: () => 1, clearTimer() {}, send: () => new Promise(resolve => { finish = resolve }) })
  queue.save('practice', { answer: 'saved' })
  const pending = queue.flush('practice'); await Promise.resolve()
  queue.stop()
  Object.keys(values).filter(key => key.startsWith('qandaSync:v1:' + id)).forEach(key => delete values[key])
  finish({ ok: true }); await pending
  assert(!Object.keys(values).some(key => key.startsWith('qandaSync:v1:' + id)), '迟到回执不会恢复已删除草稿')
  assert.equal(queue.save('practice', {}).ok, false)
  console.log('账号注销：身份复核、明确确认、匿名请求、清理恢复、账号隔离及迟到回执通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
