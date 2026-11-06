/**
 * 用户学习偏好：纯计算模块，不依赖微信 API，便于在 Node 中直接测试。
 *
 * qandaPreferences 使用平铺字段，normalizePreferences 校验并补全缺省值。
 */

const { normalizePresets } = require('./practice-presets.js')

const PREFERENCE_STORAGE_KEY = 'qandaPreferences'
const { DEFAULT_ORDER, normalizeOrder, normalizeStemPercent } = require('./practice-layout.js')
const { normalizeExamList } = require('./exam-countdown.js')

const FONT_SIZE_OPTIONS = [
  { value: 'small', label: '小' },
  { value: 'normal', label: '标准' },
  { value: 'large', label: '大' },
  { value: 'xlarge', label: '特大' },
  { value: 'xxlarge', label: '超大' }
]

// 模块顺序通过 flex order 应用，保持题目节点与滚动位置稳定。
const DEFAULT_PREFERENCES = {
  autoOpenAnalysis: true,
  // 答错是否自动进错题本
  autoAddWrongBook: true,
  // 即时反馈中客观题确认答对后自动翻题
  autoNextWhenCorrect: false,
  // 作答时是否轻微震动。**默认关闭**：vibrateShort 会让整台设备震一下，
  // 答题时被感知成「整个页面在颤抖」，且只有点选项会触发（其它按钮没有），
  // 用户很难把它和「点击动效」区分开。想开的人可在「我的 · 学习偏好」里打开。
  vibrateOnAnswer: false,
  fontSize: 'normal',
  moduleOrder: DEFAULT_ORDER,
  practiceStemPercent: 50,
  swipeEnabled: true,
  swipeDraftAction: 'save',
  examCountdowns: [],
  // 兼容已有设备的单个倒计时，读取时转换为列表。
  examName: '',
  examDate: ''
}

/** 设置页的长期答题习惯。 */
const PREFERENCE_SWITCHES = [
  { key: 'autoOpenAnalysis', heading: '答题操作', note: '新练习生效', label: '答题后自动打开解析', description: '即时反馈下，确认答案后展开；关闭时可手动打开' },
  { key: 'autoNextWhenCorrect', label: '答对后自动下一题', description: '即时反馈答对后等待 0.8 秒切题，优先于自动打开解析' },
  { key: 'swipeDraftAction', label: '左滑时先确认答案', description: '即时反馈的多选、填空先确认答案；关闭时保存草稿并切题' },
  { key: 'swipeEnabled', heading: '通用设置', label: '左右手势切题', description: '新练习生效：左滑下一题，右滑上一题' },
  {
    key: 'autoAddWrongBook',
    label: '自动收录错题',
    description: '交卷后，将答错的题加入错题本。关闭后不收录新错题，已有错题照常更新'
  },
  {
    key: 'vibrateOnAnswer',
    label: '答题时振动',
    description: '轻微震动，效果受设备及系统设置影响'
  }
]

/** 选择型偏好 */
const PREFERENCE_CHOICES = [
  {
    key: 'fontSize',
    label: '题目文字大小',
    description: '影响题干、选项、答案与解析',
    options: FONT_SIZE_OPTIONS,
    available: true
  }
]

function cloneDefaultPreferences() {
  return Object.assign({}, DEFAULT_PREFERENCES, { moduleOrder: DEFAULT_ORDER.slice(), examCountdowns: [] })
}

function isBoolean(value) {
  return typeof value === 'boolean'
}

function pickOptionValue(options, value, fallback) {
  const matched = (options || []).find((option) => option.value === value)

  return matched ? matched.value : fallback
}

/**
 * 规范化偏好：非法值一律回落到默认值，
 * 保证页面拿到的永远是一份完整可用的配置。
 */
function normalizePreferences(rawPreferences) {
  const raw = rawPreferences && typeof rawPreferences === 'object' ? rawPreferences : {}
  const next = cloneDefaultPreferences()

  Object.keys(DEFAULT_PREFERENCES).forEach((key) => {
    const value = raw[key]

    if (key === 'fontSize') {
      next[key] = pickOptionValue(PREFERENCE_CHOICES.find(item => item.key === key).options, value, DEFAULT_PREFERENCES[key])
      return
    }

    if (key === 'moduleOrder') {
      next[key] = normalizeOrder(value)
      return
    }
    if (key === 'swipeDraftAction') { next[key] = value === 'confirm' ? 'confirm' : 'save'; return }

    // 文本型偏好（考试名称 / 日期）：只接受字符串，非字符串回落默认值
    if (typeof DEFAULT_PREFERENCES[key] === 'string') {
      next[key] = typeof value === 'string' ? value : DEFAULT_PREFERENCES[key]
      return
    }

    if (isBoolean(DEFAULT_PREFERENCES[key])) {
      next[key] = isBoolean(value) ? value : DEFAULT_PREFERENCES[key]
    }
  })

  const weights = raw.practicePaneWeights
  const migrated = weights && Number.isFinite(weights.stem) && weights.stem > 0 && Number.isFinite(weights.response) && weights.response > 0
    ? Math.max(30, Math.min(70, Math.round(weights.stem / (weights.stem + weights.response) * 20) * 5)) : 50
  next.practiceStemPercent = normalizeStemPercent(raw.practiceStemPercent === undefined ? migrated : raw.practiceStemPercent)
  next.examCountdowns = normalizeExamList(Array.isArray(raw.examCountdowns)
    ? raw.examCountdowns
    : [{ id: 'legacy-exam', examName: next.examName, examDate: next.examDate }])

  Object.assign(next, normalizePresets(raw.practicePresets, raw.defaultPracticePresetId))
  return next
}

function normalizePracticeOptions(raw, preferences) {
  const defaults = normalizePreferences(preferences)
  const options = {}
  for (const key of ['autoOpenAnalysis', 'autoNextWhenCorrect', 'swipeEnabled']) {
    const value = raw && raw[key]
    options[key] = value === true || value === '1' ? true : value === false || value === '0' ? false : defaults[key]
  }
  options.swipeDraftAction = raw && ['save', 'confirm'].includes(raw.swipeDraftAction) ? raw.swipeDraftAction : defaults.swipeDraftAction
  return options
}

/** 开关型偏好的更新：只接受布尔值 */
function setPreferenceSwitch(preferences, key, value) {
  const current = normalizePreferences(preferences)

  if (!isBoolean(value)) {
    return current
  }

  if (key === 'swipeDraftAction' && current.swipeEnabled) current[key] = value ? 'confirm' : 'save'
  else if (isBoolean(current[key])) current[key] = value

  return current
}

/** 选择型偏好的更新：只接受选项内已有的值 */
function setPreferenceChoice(preferences, key, value) {
  const current = normalizePreferences(preferences)
  const definition = PREFERENCE_CHOICES.find((item) => item.key === key)

  if (!definition || !definition.available) {
    return current
  }

  current[key] = pickOptionValue(definition.options, value, current[key])

  return current
}

/**
 * 文本型偏好的更新（考试名称 / 日期）。
 * 接受整段明文而不是逐字段拼，调用方把 examName / examDate 一起传进来即可。
 */
const TEXT_PREFERENCE_KEYS = ['examName', 'examDate']

function setPreferenceText(preferences, key, value) {
  const current = normalizePreferences(preferences)

  if (TEXT_PREFERENCE_KEYS.indexOf(key) < 0) {
    return current
  }

  current[key] = typeof value === 'string' ? value : ''

  return current
}

/**
 * 构造设置页需要渲染的分组。
 * 把「有哪些开关 / 有哪些选项」收敛在一处，
 * 新增偏好只需改这个文件，页面模板不用动。
 */
function buildPreferenceView(preferences) {
  const current = normalizePreferences(preferences)

  return {
    switches: PREFERENCE_SWITCHES.map((item) => Object.assign({}, item, {
      disabled: item.key === 'swipeDraftAction' && !current.swipeEnabled,
      value: item.key === 'swipeDraftAction' ? current.swipeDraftAction === 'confirm' : current[item.key]
    })),
    choices: PREFERENCE_CHOICES.map((item) => Object.assign({}, item, {
      value: current[item.key],
      options: item.options.map((option) => Object.assign({}, option, {
        selected: option.value === current[item.key]
      }))
    }))
  }
}

/**
 * 取某个选择型偏好的当前文案。
 * 「我的」页右侧的文字大小摘要用它，避免页面自己写死一套标签，
 * 否则选项一改，摘要还停在旧文案上。
 */
function describeChoiceLabel(preferences, key) {
  const current = normalizePreferences(preferences)
  const definition = PREFERENCE_CHOICES.find((item) => item.key === key)

  if (!definition) {
    return ''
  }

  const matched = (definition.options || []).find((option) => option.value === current[key])

  return matched ? matched.label : ''
}

module.exports = {
  DEFAULT_PREFERENCES,
  FONT_SIZE_OPTIONS,
  PREFERENCE_CHOICES,
  PREFERENCE_STORAGE_KEY,
  PREFERENCE_SWITCHES,
  TEXT_PREFERENCE_KEYS,
  buildPreferenceView,
  cloneDefaultPreferences,
  describeChoiceLabel,
  normalizePreferences,
  normalizePracticeOptions,
  setPreferenceChoice,
  setPreferenceSwitch,
  setPreferenceText
}
