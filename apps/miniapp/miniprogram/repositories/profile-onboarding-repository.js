const auth = require('./auth-repository.js')
const api = require('./api-transport.js')
const { createWxStorageAdapter } = require('../utils/wx-storage.js')
let pending = null
const syncing = new Map()
function key(id) { return 'qandaProfileSetup:' + id }
function localSeen(storage, id) { try { return storage.get(key(id)) || {} } catch (_) { return {} } }
function current(identity) { return auth.getAuth(createWxStorageAdapter()).token === identity.token }
function start() { const identity = auth.getAuth(createWxStorageAdapter()); pending = identity.token ? { identity, force: true } : null }
function onLogin(identity, codeLogin) { pending = { identity, codeLogin: !!codeLogin, force: false } }
function syncSeen(identity) {
  if (!identity.token || !current(identity)) return Promise.resolve()
  const storage = createWxStorageAdapter(), record = localSeen(storage, identity.userId)
  if (!record.seen || !record.pending) return Promise.resolve()
  if (syncing.has(identity.token)) return syncing.get(identity.token)
  const request = api.request('POST', '/me/profile-setup/acknowledgement', {}, { token: identity.token, idempotencyKey: record.commandId })
    .then(result => {
      if (!result.ok || !current(identity)) return
      storage.set(key(identity.userId), { seen: true, pending: false })
      const latest = auth.getAuth(storage)
      auth.saveAuth(storage, Object.assign({}, latest, { profile: Object.assign({}, latest.profile, { profileSetupSeen: true }) }))
    }).catch(() => {}).finally(() => syncing.delete(identity.token))
  syncing.set(identity.token, request)
  return request
}
function markSeen() {
  const storage = createWxStorageAdapter(), identity = auth.getAuth(storage)
  if (!identity.token) return
  const record = localSeen(storage, identity.userId)
  try { storage.set(key(identity.userId), { seen: true, pending: true, commandId: record.commandId || api.uuid() }) } catch (_) { /* The server acknowledgement can still record this visit. */ }
  if (!localSeen(storage, identity.userId).seen) {
    return api.request('POST', '/me/profile-setup/acknowledgement', {}, { token: identity.token, idempotencyKey: api.uuid() }).catch(() => {})
  }
  return syncSeen(identity)
}

function getPending() { return pending }
function clearPending(event) { if (pending === event) pending = null }
module.exports = { start, onLogin, getPending, clearPending, localSeen, current, markSeen, syncSeen }
