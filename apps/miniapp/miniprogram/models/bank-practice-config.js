const { MODES, DURATIONS, countOptions } = require('../utils/practice-presets.js')
const DEFAULT_DURATION_MINUTES = 10
const MODE_OPTIONS = MODES
const DURATION_OPTIONS = DURATIONS
const DEFAULT_SHEET = { count: 20, mode: 'practice', duration: 0, onlyWrong: false }
function resolveModeValue(value) { return MODE_OPTIONS.some(option => option.value === value) ? value : 'practice' }
function resolveRouteMode(sheet) { return sheet.mode === 'practice' ? sheet.order === 'random' ? 'practice' : 'order' : sheet.mode }
function buildPracticeConfig(sheet, target, selected, wrongCount) {
  const chapter = target && (target.chapters || []).find(item => item.id === sheet.chapterId)
  const count = sheet.availableCount === undefined ? sheet.onlyWrong ? wrongCount : target && target.banks ? selected.reduce((sum, bank) => sum + bank.activeQuestionCount, 0) : chapter ? chapter.questionCount : target && target.questionCount || 0 : sheet.availableCount
  const allSelected = count <= 10 || sheet.count === 'ALL' || sheet.count >= count
  return {
    configTitle: sheet.mockSelection ? '模拟考配置' : '答题配置',
    configSubtitle: target ? `${target.title}${target.banks ? ' · 已选 ' + selected.length + ' 个题库' : chapter ? ' · ' + chapter.name : ''} · 共 ${count} 题` : '',
    sheetBanks: (target && target.banks || []).map(bank => ({ id: bank.id, name: bank.name, selected: (sheet.bankIds || []).includes(bank.id) })),
    sheetAllBanksSelected: !!(target && target.banks && selected.length === target.banks.length),
    sheetSomeBanksSelected: !!(selected.length && target && target.banks && selected.length < target.banks.length),
    sheetStartDisabled: !!(target && target.banks && !selected.length) || !count || allSelected && count > 1000 || !!sheet.durationError || !!sheet.scopeLoading || !!sheet.scopeError,
    sheetCount: allSelected ? 'ALL' : sheet.count,
    countOptions: countOptions(count, sheet.count), sheetMode: sheet.mode,
    sheetModeDescription: MODE_OPTIONS.find(option => option.value === sheet.mode).description,
    sheetDuration: sheet.duration, sheetDurationCustom: sheet.durationCustom || !DURATIONS.some(option => option.value === sheet.duration),
    sheetDurationError: sheet.durationError || '', sheetScopeLoading: !!sheet.scopeLoading, sheetScopeError: sheet.scopeError || '',
    sheetOnlyWrong: sheet.onlyWrong, sheetWrongCount: wrongCount,
    sheetLimitHint: count > 1000 ? '每次最多 1000 题，请缩小范围后选择全部' : '',
    sheetPresets: sheet.presets || [], sheetPresetName: sheet.presetName || '自定义', sheetPresetIndex: Math.max(0, (sheet.presets || []).findIndex(p => p.id === sheet.presetId)),
    mockSelection: !!sheet.mockSelection, modeOptions: MODE_OPTIONS, durationOptions: DURATION_OPTIONS,
    sheetStartText: sheet.mode === 'test' ? '开始模拟考' : sheet.mode === 'view' ? '开始背题' : '开始答题',
    mode: resolveRouteMode(sheet), isViewMode: sheet.mode === 'view', selectedDuration: sheet.mode === 'view' ? 0 : sheet.duration
  }
}
module.exports = { DEFAULT_DURATION_MINUTES, MODE_OPTIONS, DURATION_OPTIONS, DEFAULT_SHEET, resolveModeValue, resolveRouteMode, buildPracticeConfig }
