const repository = require('../repositories/preference-repository.js')
const { MODES, DURATIONS, INITIAL_PRESET, defaultPreset, describePreset, validCount, validDuration } = require('../utils/practice-presets.js')
class PracticePresetsViewModel {
  constructor(options) { this.storage = options.storage; this.repository = options.repository || repository; this.draft = null }
  static getInitialData() { return { presets: [], editing: false, draft: {}, modeOptions: MODES, durationOptions: DURATIONS, customDuration: false, error: '' } }
  load() {
    const preferences = this.repository.getPreferences(this.storage)
    return { data: { presets: preferences.practicePresets.map(p => ({ ...p, summary: describePreset(p), isDefault: p.id === preferences.defaultPracticePresetId })) } }
  }
  edit(id) {
    const preferences = this.repository.getPreferences(this.storage)
    const source = id ? preferences.practicePresets.find(p => p.id === id) : { ...INITIAL_PRESET, id: '', name: '' }
    if (!source) return null
    this.draft = { ...source, countInput: source.count === 'ALL' ? '' : String(source.count), durationInput: String(source.duration || '') }
    return { data: { editing: true, draft: this.draft, customDuration: !DURATIONS.some(d => d.value === source.duration), error: '' } }
  }
  change(key, value) {
    if (!this.draft || !['name', 'countInput', 'durationInput', 'mode', 'count', 'duration'].includes(key)) return null
    this.draft[key] = value
    if (key === 'name' || key.endsWith('Input')) return null
    return { data: { ['draft.' + key]: value, error: '' } }
  }
  cancel() { this.draft = null; return { data: { editing: false, error: '' } } }
  write(action) {
    try {
      const preferences = this.repository.getPreferences(this.storage)
      action(preferences)
      this.repository.savePreferences(this.storage, preferences)
      return { data: { ...this.load().data, editing: false, error: '' }, command: { type: 'toast', title: '已保存' } }
    } catch (error) { return { data: { error: error.message || '保存失败，请重试' } } }
  }
  save(customDuration) {
    const draft = this.draft
    if (!draft) return null
    const name = draft.name.trim()
    const count = draft.count === 'ALL' ? 'ALL' : Number(draft.countInput)
    const duration = draft.mode === 'view' ? 0 : customDuration ? Number(draft.durationInput) : Number(draft.duration)
    const error = !name || name.length > 30 ? '请输入 1～30 字的预设名称' : !validCount(count) || count !== 'ALL' && !/^\d+$/.test(draft.countInput) ? '题量应为 1～1000 的整数，或选择全部' : !validDuration(duration) || customDuration && draft.mode !== 'view' && (!/^\d+$/.test(draft.durationInput) || !duration) ? '请输入 1～1440 的整数分钟' : ''
    if (error) return { data: { error } }
    const saved = { id: draft.id || 'preset-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, mode: draft.mode, count, duration }
    return this.write(preferences => { preferences.practicePresets = draft.id ? preferences.practicePresets.map(p => p.id === draft.id ? saved : p) : preferences.practicePresets.concat(saved) })
  }
  setDefault(id) {
    return this.write(preferences => { if (!preferences.practicePresets.some(p => p.id === id)) throw new Error('预设不存在，请重新选择'); preferences.defaultPracticePresetId = id })
  }
  remove(id) {
    return this.write(preferences => { if (defaultPreset(preferences).id === id) throw new Error('请先将其他预设设为默认'); preferences.practicePresets = preferences.practicePresets.filter(p => p.id !== id) })
  }
}
module.exports = { PracticePresetsViewModel }
