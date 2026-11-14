const {
  PREFERENCE_STORAGE_KEY,
  normalizePreferences,
  setPreferenceChoice,
  setPreferenceSwitch
} = require('../utils/preferences.js')

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
    raw = adapter.get(PREFERENCE_STORAGE_KEY)
  } catch (error) {
    raw = null
  }

  return normalizePreferences(raw)
}

function savePreferences(storage, preferences) {
  const adapter = getStorageAdapter(storage)
  const normalized = normalizePreferences(preferences)

  adapter.set(PREFERENCE_STORAGE_KEY, normalized)

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
module.exports = { getPreferences, resetPreferences, savePreferences, getDefaultPracticeRoute, updatePreferenceChoice, updatePreferenceSwitch }
