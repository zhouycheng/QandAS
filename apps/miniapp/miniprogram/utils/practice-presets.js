const MODES = [
  { value: 'practice', label: '练习', description: '按本次配置查看对错、答案和解析' },
  { value: 'test', label: '模拟考', description: '交卷后统一查看对错、答案和解析' },
  { value: 'view', label: '背题', description: '直接查看题目、答案和解析' }
]
const DURATIONS = [0, 10, 20, 35].map(value => ({ value, label: value ? value + ' 分钟' : '不限时' }))
const INITIAL_PRESET = { id: 'daily', name: '日常练习', mode: 'practice', feedback: 'IMMEDIATE', order: 'order', count: 20, duration: 0 }
function feedbackForMode(config) {
  return config.mode === 'test' ? 'AFTER_FINISH' : config.mode === 'view' ? 'IMMEDIATE' : config.feedback === 'AFTER_FINISH' ? 'AFTER_FINISH' : 'IMMEDIATE'
}
function feedbackLabel(config) { return feedbackForMode(config) === 'IMMEDIATE' ? '即时反馈' : '交卷后反馈' }
function orderForMode(config) { return config.mode === 'test' ? 'random' : config.mode === 'view' ? 'order' : config.order === 'random' ? 'random' : 'order' }
function orderLabel(config) { return orderForMode(config) === 'random' ? '随机' : '顺序' }
function validCount(value) { return value === 'ALL' || Number.isInteger(value) && value >= 1 && value <= 1000 }
function validDuration(value) { return Number.isInteger(value) && value >= 0 && value <= 1440 }
function normalizePresets(raw, defaultId) {
  const presets = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item.id !== 'string' || !item.id || presets.some(p => p.id === item.id) || typeof item.name !== 'string' || !item.name.trim() || !MODES.some(m => m.value === item.mode) || !validCount(item.count) || !validDuration(item.duration)) continue
    presets.push({ id: item.id, name: item.name.trim().slice(0, 30), mode: item.mode, feedback: feedbackForMode(item), order: orderForMode(item), count: item.count, duration: item.mode === 'view' ? 0 : item.duration })
  }
  if (!presets.length) presets.push({ ...INITIAL_PRESET })
  return { practicePresets: presets, defaultPracticePresetId: presets.some(p => p.id === defaultId) ? defaultId : presets[0].id }
}
function defaultPreset(preferences) {
  const normalized = normalizePresets(preferences.practicePresets, preferences.defaultPracticePresetId)
  return normalized.practicePresets.find(p => p.id === normalized.defaultPracticePresetId)
}
function describePreset(preset) {
  return MODES.find(m => m.value === preset.mode).label + (preset.mode === 'practice' ? ' · ' + feedbackLabel(preset) + ' · ' + orderLabel(preset) : '') + ' · ' + (preset.count === 'ALL' ? '全部' : preset.count + ' 题') + ' · ' + (preset.duration ? preset.duration + ' 分钟' : '不限时')
}
function routeForPreset(preset) {
  const count = validCount(preset.count) ? preset.count : 20
  return { mode: preset.mode === 'practice' ? orderForMode(preset) === 'random' ? 'practice' : 'order' : preset.mode,
    feedback: feedbackForMode(preset), count: count === 'ALL' ? 1000 : count, ...(count === 'ALL' ? { countAll: '1' } : {}), duration: String(preset.mode === 'view' ? 0 : preset.duration || 0) }
}
function routeQuery(route) { return Object.keys(route).map(key => key + '=' + encodeURIComponent(route[key])).join('&') }
function timeLimitSeconds(route) {
  if (route.mode === 'view') return null
  if (route.duration === undefined || route.duration === '') return route.mode === 'test' ? 600 : null
  const minutes = Number(route.duration)
  if (!validDuration(minutes)) throw new Error('答题时间应为 0～1440 的整数分钟')
  return minutes ? minutes * 60 : null
}
function countOptions(total, configured) {
  if (!total) return []
  const values = new Set()
  if (total > 10) {
    const steps = [5, 10, 20, 40, 50, 80, 100, 200, 400, 500, 800, 1000]
    for (const ratio of [1 / 8, 1 / 4, 1 / 2]) {
      const target = total * ratio
      values.add(steps.reduce((best, value) => Math.abs(value - target) <= Math.abs(best - target) ? value : best))
    }
    if (validCount(configured) && configured !== 'ALL') values.add(configured)
  }
  return [...values].filter(value => value < total).sort((a, b) => a - b).map(value => ({ value, label: value + ' 题', disabled: false }))
    .concat({ value: 'ALL', label: '全部', disabled: total > 1000 })
}
module.exports = { MODES, DURATIONS, INITIAL_PRESET, feedbackForMode, feedbackLabel, orderForMode, orderLabel, validCount, validDuration, normalizePresets, defaultPreset, describePreset, routeForPreset, routeQuery, timeLimitSeconds, countOptions }
