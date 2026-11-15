const http = require('./http-gateway.js')

function createWriterSocket(options) {
  const schedule = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout
  const now = options.now || Date.now, random = options.random || Math.random
  let socket, stopped = false, generation = 0, heartbeat, expiry, retry, failures = 0
  const clear = () => { [heartbeat, expiry, retry].forEach(timer => { if (timer) cancel(timer) }); heartbeat = expiry = retry = null }
  function disconnected(current) {
    if (stopped || current !== generation) return
    generation += 1; clear()
    if (socket) { const old = socket; socket = null; old.close({}) }
    options.onEvent({ type: 'DISCONNECTED' })
    retry = schedule(open, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) * (0.5 + random() * 0.5))
  }
  function alive(current, leaseMillis) {
    if (expiry) cancel(expiry)
    expiry = schedule(() => disconnected(current), Math.min(40000, leaseMillis || 40000))
    if (heartbeat) cancel(heartbeat)
    heartbeat = schedule(() => {
      if (stopped || current !== generation || !socket) return
      socket.send({ data: JSON.stringify({ type: 'PING' }), fail: () => disconnected(current) })
    }, 30000)
  }
  function open() {
    if (stopped || !options.current()) return
    const current = ++generation
    const binding = options.binding()
    const url = `${http.getConfig().baseUrl.replace(/^http/, 'ws')}/api/v1/practice/writer-socket?sessionId=${encodeURIComponent(options.id)}&deviceId=${encodeURIComponent(options.deviceId)}`
    try {
      socket = options.connect({ url, header: { Authorization: `Bearer ${options.token}` }, fail: () => disconnected(current) })
      socket.onOpen(() => {
        if (stopped || current !== generation) return
        socket.send({ data: JSON.stringify({ type: 'BIND', writerToken: binding.writerToken || null, epoch: binding.epoch || 0 }), fail: () => disconnected(current) })
      })
      socket.onMessage(message => {
        if (stopped || current !== generation || !options.current()) return
        let data
        try { data = JSON.parse(message.data) } catch (_) { disconnected(current); return }
        if (data.type === 'BOUND' || data.type === 'PONG') { failures = 0; alive(current, data.leaseMillis); data.receivedAt = now() }
        options.onEvent(data)
      })
      socket.onClose(() => disconnected(current)); socket.onError(() => disconnected(current))
      expiry = schedule(() => disconnected(current), 10000)
    } catch (_) { disconnected(current) }
  }
  open()
  return { stop() { stopped = true; generation += 1; clear(); if (socket) { const old = socket; socket = null; old.close({}) } }, reconnect() { disconnected(generation) } }
}
module.exports = { createWriterSocket }
