const assert = require('node:assert/strict')
const { createFeedbackRepository } = require('../miniprogram/repositories/feedback-repository.js')
const { FeedbackViewModel } = require('../miniprogram/viewmodels/feedback-viewmodel.js')
const { buildEmailAuth } = require('../miniprogram/utils/auth-session.js')
async function run() {
  let auth = buildEmailAuth({ userId: 'a', token: 'token-a', email: 'a@example.test' })
  const storage = { get: () => auth }
  const calls = []
  let fail = true, finish
  const repository = createFeedbackRepository(storage, { request: async (...args) => { calls.push(args); return fail ? { ok: false, reason: '网络超时' } : { ok: true, data: { id: 'feedback' } } } })
  await assert.rejects(repository.submit('course', { courseName: '数学', body: '基础题库' }), /超时/)
  fail = false
  await repository.submit('course', { courseName: '数学', body: '基础题库' })
  assert.equal(calls[0][3].idempotencyKey, calls[1][3].idempotencyKey)
  const late = createFeedbackRepository(storage, { request: () => new Promise(resolve => { finish = resolve }) })
  const pending = late.list('question', 1)
  auth = buildEmailAuth({ userId: 'b', token: 'token-b', email: 'b@example.test' })
  finish({ ok: true, data: { items: [] } })
  await assert.rejects(pending, /登录/)
  let count = 0
  const vm = new FeedbackViewModel({ storage, repository: { submit: () => { count++; return new Promise(resolve => { finish = resolve }) }, list: async () => ({ items: [{ id: 'q', status: 'RESOLVED', body: '问题', response: '已修正', question: { stem: '题干', correctAnswer: ['A'] } }], total: 1, page: 1, pageSize: 20 }) } })
  vm.load({ kind: 'course', compose: '1' })
  assert.match((await vm.submit({ body: '' })).command.title, /描述/)
  const submission = vm.submit({ courseName: '数学', body: '增加课程' })
  await vm.submit({ courseName: '数学', body: '增加课程' })
  assert.equal(count, 1)
  finish({}); await submission
  const data = (await vm.list(1)).data
  assert.equal(data.items[0].response, '已修正')
  assert.equal(JSON.stringify(data).includes('correctAnswer'), false, '列表只投影反馈展示字段')
  console.log('feedback: idempotent retry, duplicate tap, identity isolation, validation and result projection passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
