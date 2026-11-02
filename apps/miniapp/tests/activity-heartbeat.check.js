const assert = require('node:assert/strict')
const { createHeartbeat } = require('../miniprogram/repositories/activity-heartbeat.js')
const tick = () => new Promise(resolve => setImmediate(resolve))
async function run() {
  let auth = {}, calls = [], timers = [], finish
  const heartbeat = createHeartbeat({
    getAuth: () => auth,
    setTimeout: (fn, delay) => { assert.equal(delay, 60000); const task = { fn }; timers.push(task); return task },
    clearTimeout: task => { timers = timers.filter(item => item !== task) },
    request: (method, path, data, options) => { calls.push(options); return new Promise(resolve => { finish = resolve }) }
  })
  await heartbeat.start(); assert.equal(calls.length, 0)
  auth = { userId: 'one', token: 'one-token' }
  heartbeat.start(); await tick(); assert.equal(calls.length, 1)
  heartbeat.start(); await tick(); assert.equal(calls.length, 1, '心跳同一时间只允许一个请求')
  heartbeat.stop(); assert.equal(calls[0].shouldSend(), false, '退后台使未发送心跳失效')
  finish({ ok: true }); await tick(); assert.equal(timers.length, 0)
  heartbeat.start(); await tick(); finish({ ok: true }); await tick()
  assert.equal(timers.length, 1)
  const next = timers.shift(); next.fn(); await tick(); assert.equal(calls.length, 3)
  auth = { userId: 'two', token: 'two-token' }; heartbeat.start()
  assert.equal(calls[2].shouldSend(), false)
  finish({ ok: true }); await tick(); assert.equal(calls.at(-1).token, 'two-token')
  finish({ statusCode: 401 }); await tick(); assert.equal(timers.length, 0, '认证失效停止自动心跳')
  heartbeat.stop()
  console.log('foreground heartbeat: timing, cancellation, identity and expiry passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
