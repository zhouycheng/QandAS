const assert = require('node:assert/strict')
const { OnlinePractice } = require('../miniprogram/repositories/online-practice.js')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const http = require('../miniprogram/repositories/http-gateway.js')
const copy = value => JSON.parse(JSON.stringify(value))

async function main() {
  const records = { qandaAuth: { provider: 'email', userId: 'u1', token: 'token1' }, qandaDeviceId: 'device1' }
  const storage = { get: key => records[key] && copy(records[key]), set: (key, value) => { records[key] = copy(value) }, remove: key => delete records[key] }
  const runtime = new OnlinePractice(storage)
  runtime.identity()
  const snapshot = { id: 's1', questionBankId: 'b1', status: 'IN_PROGRESS', version: 1, currentIndex: 0, durationSeconds: 0,
    route: { bankId: 'b1', mode: 'practice' }, writer: { deviceId: 'device1', writerToken: 'fixed-token', acknowledgedSequence: 0 },
    items: [{ itemId: 'i1', position: 0, question: { id: 'q1', type: 'SINGLE_CHOICE', stem: '题目', options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }] } }],
    offlineGrading: [{ itemId: 'i1', correctAnswer: ['A'], explanation: '解析' }] }
  runtime.put('s1', snapshot)
  const session = new PracticeSession({ quiz: runtime.quiz(snapshot), restored: runtime.restored(snapshot), mode: 'practice' })
  session.reset(); session.restore(runtime.restored(snapshot)); session.selectOption(0)
  runtime.save(session)
  runtime.queue.stop()
  const restarted = new OnlinePractice(storage)
  assert.equal((await restarted.prepare({ sessionId: 's1' })).localState.answers[0].selectedKeys[0], 'A')
  assert.equal(restarted.get('s1').writer.writerToken, 'fixed-token')
  storage.set('qandaDeviceId', 'device2')
  await assert.rejects(restarted.prepare({ sessionId: 's1' }), /创建练习的设备/)
  storage.set('qandaDeviceId', 'device1')
  const request = http.request
  http.request = async () => { throw new Error('账号切换后不得发送原账号请求') }
  storage.set('qandaAuth', { provider: 'email', userId: 'u2', token: 'token2' })
  assert.equal((await restarted.send('s1', {}, 'u1')).statusCode, 401)
  http.request = request
  restarted.queue.stop()
  console.log('single-device restart, offline drafts, fixed credentials and identity isolation passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
