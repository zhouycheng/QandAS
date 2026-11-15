const {
  PREFERENCE_STORAGE_KEY,
  normalizePreferences,
  setPreferenceChoice,
  setPreferenceSwitch
} = require('../utils/preferences.js')
const auth = require('./auth-repository.js')
const http = require('./http-gateway.js')
const flights = new Map(), listeners = new Set()
let enabled = false, retryTimer = null, activeStorage = null
const accountKey = id => `qandaPreferences:account:${id}`
function identity(storage) { return auth.getAuth(storage) }
function record(storage, id) { return storage.get(accountKey(id)) || { preferences: normalizePreferences(null), version: 1, revision: 0, loaded: false, dirty: false } }
function notify(id, state) {
  listeners.forEach(row => {
    if (identity(row.storage).userId !== id) return
    try { row.listener(state || syncState(row.storage)) } catch (_) { /* 页面已隐藏时仍完成可靠保存。 */ }
  })
}
function write(storage, id, value) { storage.set(accountKey(id), value); notify(id) }
function syncState(storage) {
  const a = identity(storage), value = a.loggedIn ? record(storage, a.userId) : {}
  return { preferenceConflict: !!value.conflict, preferenceCanRetry: !!value.error && !value.conflict,
    preferenceSyncMessage: value.conflict ? '其他设备已修改设置，请选择保留哪一份' : value.error || '' }
}
function observe(storage, listener) { const row = { storage, listener }; listeners.add(row); listener(syncState(storage)); return () => listeners.delete(row) }
function schedule(storage, delay = 0) {
  if (!enabled || !http.isConfigured()) return
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => refreshPreferences(storage).catch(() => {}), delay)
  if (retryTimer.unref) retryTimer.unref()
}
function enable(storage) { enabled = true; activeStorage = storage }
async function refreshPreferences(storage = activeStorage) {
  if (!storage || !http.isConfigured()) return null
  const a = identity(storage)
  if (!a.loggedIn || !a.token) return null
  const key = `${a.userId}:${a.token}`
  if (flights.has(key)) return flights.get(key)
  const same = () => { const next = identity(storage); return next.userId === a.userId && next.token === a.token }
  const request = async (method, body, intentKey) => {
    const result = await http.request(method, '/me/preferences', body, { token: a.token, ...(method === 'PUT' ? { priority: 'background' } : {}), ...(intentKey ? { idempotencyKey: intentKey } : {}) })
    if (!same()) throw Object.assign(new Error('账号已切换'), { stale: true })
    if (!result.ok) throw Object.assign(new Error(result.reason || '设置已保存在本机，稍后重试同步'), { statusCode: result.statusCode || 0, retryAfter: result.retryAfter })
    return result.data
  }
  const pending = Promise.resolve().then(async () => {
    let value = record(storage, a.userId)
    if (value.conflict) return value
    if (!value.intent) {
      const remote = await request('GET')
      value = record(storage, a.userId)
      if (value.dirty && remote.version !== value.version) {
        value.cloud = remote; value.conflict = true
      } else {
        value.version = remote.version; value.loaded = true; value.error = ''
        if (!value.dirty) value.preferences = normalizePreferences(remote.preferences)
      }
      write(storage, a.userId, value)
    }
    while (same()) {
      value = record(storage, a.userId)
      if (!value.dirty || value.conflict) return value
      if (!value.intent) {
        value.intent = { key: http.uuid(), revision: value.revision, body: { expectedVersion: value.version, preferences: value.preferences } }
        write(storage, a.userId, value)
      }
      const intent = value.intent
      let remote
      try { remote = await request('PUT', intent.body, intent.key) }
      catch (error) {
        if (error.statusCode !== 409) throw error
        remote = await request('GET')
        value = record(storage, a.userId); value.cloud = remote; value.conflict = true; delete value.intent
        write(storage, a.userId, value); return value
      }
      value = record(storage, a.userId)
      value.version = remote.version; value.loaded = true; value.dirty = value.revision !== intent.revision; value.error = ''; delete value.intent
      if (!value.dirty) value.preferences = normalizePreferences(remote.preferences)
      write(storage, a.userId, value)
    }
    return null
  }).catch(error => {
    if (!same() || error.stale) return null
    const value = record(storage, a.userId)
    value.error = error.statusCode === 401 || error.statusCode === 403 ? '请登录原账号后同步设置' : error.message
    try { write(storage, a.userId, value) }
    catch (_) { notify(a.userId, { preferenceConflict: false, preferenceCanRetry: true, preferenceSyncMessage: '设置暂时无法保存到本机，请释放空间后重试' }) }
    if (!error.statusCode || [408, 429].includes(error.statusCode) || error.statusCode >= 500) schedule(storage, Math.max(10000, error.retryAfter || 0))
    return value
  }).finally(() => { if (flights.get(key) === pending) flights.delete(key) })
  flights.set(key, pending)
  return pending
}
function resolveConflict(storage, useLocal) {
  const a = identity(storage), value = record(storage, a.userId)
  if (!a.loggedIn || !value.conflict || !value.cloud) return Promise.resolve(null)
  value.version = value.cloud.version; value.loaded = true; value.dirty = !!useLocal; value.conflict = false; value.error = ''
  if (!useLocal) value.preferences = normalizePreferences(value.cloud.preferences)
  delete value.cloud; delete value.intent
  write(storage, a.userId, value)
  return refreshPreferences(storage)
}

/**
 * 仓储层：只负责学习偏好的读写，取值规则在 utils/preferences.js。
 * storage 由页面注入，未注入时退化为默认偏好，便于在 Node 中测试。
 */
function createNullStorage() {
  return {
    get() {
      return null
    },

    set() {}
  }
}

function getStorageAdapter(storage) {
  return storage || createNullStorage()
}

function getPreferences(storage) {
  const adapter = getStorageAdapter(storage)
  let raw = null

  try {
    const a = identity(adapter)
    raw = a.loggedIn ? record(adapter, a.userId).preferences : adapter.get(PREFERENCE_STORAGE_KEY)
  } catch (error) {
    raw = null
  }

  return normalizePreferences(raw)
}

function savePreferences(storage, preferences) {
  const adapter = getStorageAdapter(storage)
  const normalized = normalizePreferences(preferences)

  const a = identity(adapter)
  if (a.loggedIn) {
    const value = record(adapter, a.userId)
    value.preferences = normalized; value.revision += 1; value.dirty = true
    write(adapter, a.userId, value)
    schedule(adapter)
  } else adapter.set(PREFERENCE_STORAGE_KEY, normalized)

  return normalized
}

function updatePreferenceSwitch(storage, key, value) {
  return savePreferences(storage, setPreferenceSwitch(getPreferences(storage), key, value))
}

function updatePreferenceChoice(storage, key, value) {
  return savePreferences(storage, setPreferenceChoice(getPreferences(storage), key, value))
}

/** 恢复长期习惯，保留预设、布局和倒计时。 */
function resetPreferences(storage) {
  const current = getPreferences(storage)
  const defaults = normalizePreferences(null)
  for (const key of ['optionOutline', 'vibrateOnAnswer', 'fontSize', 'autoOpenAnalysis', 'autoNextWhenCorrect', 'swipeEnabled', 'swipeDraftAction']) current[key] = defaults[key]
  return savePreferences(storage, current)
}
function getDefaultPracticeRoute(storage) {
  const preferences = getPreferences(storage)
  const { defaultPreset, routeForPreset } = require('../utils/practice-presets.js')
  return routeForPreset(defaultPreset(preferences))
}
module.exports = { getPreferences, resetPreferences, savePreferences, getDefaultPracticeRoute, updatePreferenceChoice, updatePreferenceSwitch, enable, refreshPreferences, observe, syncState, resolveConflict }
