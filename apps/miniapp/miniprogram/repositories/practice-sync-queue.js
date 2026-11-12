const { uuid } = require('./api-transport.js')
const PREFIX = 'qandaSync:v1:'
const copy = value => JSON.parse(JSON.stringify(value))
function createSyncQueue(options) {
  const { storage, userId, send } = options
  if (!userId || !storage || typeof send !== 'function') throw new Error('暂时无法保存答题进度，请重新打开练习')
  const now = options.now || Date.now, random = options.random || Math.random
  const setTimer = options.setTimer || setTimeout, clearTimer = options.clearTimer || clearTimeout
  const indexKey = `${PREFIX}${userId}:index`, timers = {}, sending = {}
  const cooldownKey = `qandaSyncCooldown:v1:${userId}`
  let active = false
  let stopped = false
  const ordinaryDelay = () => 60000 + random() * 10000
  const cooldown = () => storage.get(cooldownKey) || { until: 0, failures: 0 }
  const key = id => `${PREFIX}${userId}:${id}`
  function ids() {
    const index = storage.get(indexKey) || []
    const keys = storage.keysStrict ? storage.keysStrict() : storage.keys ? storage.keys() : []
    return Array.from(new Set(index.concat(keys.filter(k => k.startsWith(`${PREFIX}${userId}:`) && k !== indexKey).map(k => k.slice(`${PREFIX}${userId}:`.length)))))
  }
  function get(id) {
    const value = storage.get(key(id))
    if (!value) return null
    if (value.userId !== userId || value.sessionId !== id) throw new Error('答题记录暂时无法读取，请保留本机数据')
    return copy(value)
  }
  function persist(id, value) {
    // Register before writing content: an interrupted content write leaves a harmless empty index entry.
    const index = ids()
    if (!index.includes(id)) storage.set(indexKey, index.concat(id))
    storage.set(key(id), value)
    if (options.onChange) options.onChange(id, copy(value))
  }
  function cancel(id) { if (timers[id] !== undefined) { clearTimer(timers[id]); delete timers[id] } }
  function schedule(id, delay) {
    if (stopped || timers[id] !== undefined) return
    timers[id] = setTimer(() => { delete timers[id]; flush(id, false) }, delay)
  }
  function idle(draft) { return !draft || (!draft.pending && draft.revision <= draft.acknowledgedRevision && (!draft.finish || draft.finished)) }
  function save(id, payload, finish = false) {
    if (stopped) return { ok: false, paused: true }
    try {
      const previous = get(id)
      if (previous && previous.finish) return { ok: true, unchanged: true, draft: previous }
      if (!finish && previous && JSON.stringify(previous.payload.progress || previous.payload) === JSON.stringify(payload.progress || payload)) return { ok: true, unchanged: true, draft: previous }
      const draft = Object.assign({ userId, sessionId: id, revision: 0, acknowledgedRevision: 0, sequence: 0, acknowledgedSequence: 0, acceptedSequence: 0, pending: null, failures: 0 }, previous || {}, { payload: copy(payload), revision: (previous && previous.revision || 0) + 1, updatedAt: now() })
      if (!previous || idle(previous)) { draft.dirtySince = now(); draft.readyAt = now() + ordinaryDelay() }
      if (finish) { draft.finish = true; draft.readyAt = now(); cancel(id) }
      persist(id, draft)
      schedule(id, Math.max(0, (draft.readyAt || now()) - now()))
      return { ok: true, draft: copy(draft) }
    } catch (_) { return { ok: false, storageError: true, reason: '答题数据保存失败，请检查设备存储空间' } }
  }
  function flush(id, force = true) {
    if (sending[id]) return sending[id]
    cancel(id)
    let draft
    try {
      draft = get(id)
      if (idle(draft)) return Promise.resolve({ ok: true, idle: true })
      if (draft.paused || stopped) return Promise.resolve({ ok: false, paused: true, reason: draft.reason })
      const waitUntil = Math.max(draft.nextAttemptAt || 0, cooldown().until, force ? 0 : draft.readyAt || 0)
      if (waitUntil > now()) { schedule(id, waitUntil - now()); return Promise.resolve({ ok: false, deferred: true, retryAfter: waitUntil - now() }) }
      const due = ids().map(other => ({ id: other, draft: get(other) })).filter(row => row.draft && !idle(row.draft) && !row.draft.paused && Math.max(row.draft.nextAttemptAt || 0, row.draft.readyAt || 0) <= now())
      due.sort((a, b) => (now() - (b.draft.dirtySince || now()) >= 60000 ? 2 : b.draft.finish ? 1 : 0) - (now() - (a.draft.dirtySince || now()) >= 60000 ? 2 : a.draft.finish ? 1 : 0) || (a.draft.dirtySince || 0) - (b.draft.dirtySince || 0))
      if (active || !force && due.length && due[0].id !== id) { schedule(id, 1000 + random() * 1000); return Promise.resolve({ ok: false, deferred: true, retryAfter: 1000 }) }
      if (!draft.pending) {
        draft.sequence += 1
        draft.pending = { sequence: draft.sequence, revision: draft.revision, kind: draft.finish ? 'FINISH' : 'SAVE', payload: copy(draft.payload), idempotencyKey: uuid() }
      }
      draft.pending.reconcile = !!draft.pending.attempted
      draft.pending.attempted = true
      persist(id, draft)
    } catch (_) { return Promise.resolve({ ok: false, storageError: true, reason: '本机保存失败，请重试' }) }
    active = true
    const command = copy(draft.pending)
    sending[id] = Promise.resolve().then(() => send(id, command)).catch(() => ({ ok: false, statusCode: 0 })).then(result => {
      if (stopped) return result
      try {
        const current = get(id)
        if (!current || !current.pending || current.pending.idempotencyKey !== command.idempotencyKey) return result
        let delay = 0
        if (result.pending) {
          current.pending.serverAccepted = true
          current.acceptedSequence = Math.max(current.acceptedSequence, command.sequence)
          current.polls = (current.polls || 0) + 1
          current.failures = 0
          delay = Math.max(result.retryAfter || 0, [1000, 2000, 4000, 8000, 15000, 30000][Math.min(current.polls - 1, 5)] * (1 + random() * 0.25))
          current.reason = '已保存在本机，可继续练习'
        } else if (result.ok) {
          current.acknowledgedSequence = command.sequence
          current.acceptedSequence = Math.max(current.acceptedSequence, command.sequence)
          current.acknowledgedRevision = command.revision
          current.lastAcknowledgedKey = command.idempotencyKey
          current.pending = null; current.failures = 0; current.polls = 0; current.reason = ''
          current.finished = command.kind === 'FINISH'
          current.lastResponse = Object.assign({}, result, { result: undefined, data: undefined })
          storage.remove(cooldownKey)
          current.dirtySince = now(); current.readyAt = now() + (current.finish ? 0 : ordinaryDelay())
          delay = current.finish ? 0 : Math.max(0, current.readyAt - now())
        } else {
          current.failures += 1
          const status = result.statusCode || 0
          current.lastStatusCode = status; current.rejected = !!result.rejected
          current.paused = [401, 403, 409].includes(status) || status >= 400 && status < 500 && ![408, 429].includes(status)
          current.reason = result.reason || '已保存在本机，可继续练习'
          const shared = cooldown()
          const failures = shared.failures + 1
          delay = Math.max(result.retryAfter || 0, Math.min(300000, 10000 * Math.pow(2, Math.min(failures - 1, 6))) * (0.5 + random() * 0.5))
          if (!current.paused) storage.set(cooldownKey, { until: now() + delay, failures })
        }
        current.nextAttemptAt = result.ok || idle(current) || current.paused ? 0 : now() + delay
        persist(id, current)
        if (!idle(current) && !current.paused) schedule(id, delay)
        return result
      } catch (_) { schedule(id, 5000); return { ok: false, storageError: true, reason: '本次作答未能保存，请释放空间后重试' } }
    }).then(result => { delete sending[id]; active = false; return result })
    return sending[id]
  }
  function resume(id) {
    const draft = get(id)
    if (draft && [401, 403].includes(draft.lastStatusCode)) { draft.paused = false; persist(id, draft) }
    return flush(id)
  }
  function removeConfirmed(id) {
    if (sending[id] || !idle(get(id))) return false
    cancel(id); storage.remove(key(id)); storage.set(indexKey, ids().filter(value => value !== id)); return true
  }
  const flushAll = () => Promise.all(ids().map(id => flush(id, false)))
  return { save, finish: (id, payload) => save(id, payload, true), get, flush, flushAll, resume, resumeAuthOnly: () => Promise.all(ids().filter(id => { const d = get(id); return d && d.paused && [401, 403].includes(d.lastStatusCode) }).map(resume)), removeConfirmed, sessionIds: ids, stop() { stopped = true; Object.keys(timers).forEach(cancel) } }
}
module.exports = { createSyncQueue }
