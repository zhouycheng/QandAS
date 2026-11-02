const transport = require('./api-transport.js')

function createHeartbeat(options) {
  const request = options.request || transport.request
  const schedule = options.setTimeout || setTimeout
  const cancel = options.clearTimeout || clearTimeout
  let visible = false, timer = null, pending = null, blockedToken = '', epoch = 0
  function stop() { visible = false; epoch += 1; if (timer) cancel(timer); timer = null }
  function start() {
    visible = true
    epoch += 1
    if (timer) cancel(timer)
    timer = null
    return send()
  }
  function send() {
    const auth = options.getAuth() || {}
    if (!visible || !auth.token || !auth.userId || blockedToken === auth.token) return Promise.resolve()
    if (pending) return pending
    const generation = epoch
    const current = () => visible && generation === epoch && (options.getAuth() || {}).token === auth.token
    const work = Promise.resolve().then(() => request('POST', '/me/activity/heartbeat', {}, {
      token: auth.token, priority: 'background', shouldSend: current
    })).then(result => { if (current() && result && result.statusCode === 401) blockedToken = auth.token }).catch(() => {})
      .finally(() => {
        pending = null
        if (!visible) return
        if (generation !== epoch || (options.getAuth() || {}).token !== auth.token) { send(); return }
        if (blockedToken !== auth.token) timer = schedule(() => { timer = null; send() }, 60000)
      })
    pending = work
    return work
  }
  return { start, stop }
}
module.exports = { createHeartbeat }
