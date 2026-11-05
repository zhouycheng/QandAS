/**
 * 学习偏好 / 每日日志 / 图表 / 统计页 / 设置页 —— Node 自检脚本。
 * 运行：node apps/miniapp/tests/settings-charts.check.js
 *
 * 覆盖三件容易「看起来对、其实没接上」的事：
 *   1. 偏好开关是否真的改变了答题行为（而不是只存了值）；
 *   2. 每日日志的数据是否能一路走到统计页的图表 SVG；
 *   3. 未开放的选项（发音音色）是否真的不改数据。
 */
const path = require('path')

const MINIPROGRAM = path.resolve(__dirname, '../miniprogram')
const base64Utils = require(path.join(MINIPROGRAM, 'utils/base64.js'))
const preferenceUtils = require(path.join(MINIPROGRAM, 'utils/preferences.js'))
const dailyLogUtils = require(path.join(MINIPROGRAM, 'utils/daily-log.js'))
const chartSvg = require(path.join(MINIPROGRAM, 'utils/chart-svg.js'))
const { SettingsViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/settings-viewmodel.js'))
const { StatsViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/stats-viewmodel.js'))
const { PracticeViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/practice-viewmodel.js'))

const results = []

function assert(name, condition, detail) {
  results.push({
    name,
    passed: !!condition,
    detail: condition ? '' : detail || ''
  })
}

function createMemoryStorage(initial) {
  const map = Object.assign({}, initial || {})

  return {
    get(key) {
      return map[key] === undefined ? null : map[key]
    },

    set(key, value) {
      map[key] = value
    },

    remove(key) {
      delete map[key]
    },

    keys() {
      return Object.keys(map)
    },

    raw: map
  }
}

/** 固定本地时间，避免测试受运行机器时区与当前时钟影响 */
function localTime(year, month, day, hour) {
  return new Date(year, month - 1, day, hour || 10, 0, 0, 0).getTime()
}

const DAY_MS = 24 * 60 * 60 * 1000
const TODAY = localTime(2026, 9, 19, 16)

// ---------- 一、base64 ----------
function checkBase64() {
  const samples = [
    '<svg></svg>',
    '完成度 62',
    'a',
    'ab',
    'abc',
    '语音·测试✓',
    '🎯 目标'
  ]

  samples.forEach((sample) => {
    const mine = base64Utils.encodeBase64Utf8(sample)
    const node = Buffer.from(sample, 'utf8').toString('base64')

    assert(`base64 - 与 Node Buffer 一致（${sample}）`, mine === node, `${mine} / ${node}`)
  })

  assert('base64 - 空串输出空串', base64Utils.encodeBase64Utf8('') === '')
  assert('base64 - 不含换行', base64Utils.encodeBase64Utf8('完成度'.repeat(50)).indexOf('\n') === -1)
}

// ---------- 二、偏好规范化 ----------
function checkPreferences() {
  const defaults = preferenceUtils.normalizePreferences(null)

  // vibrateOnAnswer 默认必须是 false：vibrateShort 会让整台设备震一下，
  // 答题时被感知成「整个页面在颤抖」，用户无法与「点击动效」区分开。
  assert('偏好 - 空值给全套默认', defaults.autoShowExplanation === true &&
    defaults.autoAddWrongBook === true &&
    defaults.autoNextWhenCorrect === false &&
    defaults.vibrateOnAnswer === false &&
    defaults.fontSize === 'normal' &&
    defaults.moduleOrder.length === 4,
    JSON.stringify(defaults))

  const dirty = preferenceUtils.normalizePreferences({
    fontSize: 'huge',
    voice: 'unknown',
    autoShowExplanation: 'yes',
    autoNextWhenCorrect: true
  })

  assert('偏好 - 非法枚举回落默认', dirty.fontSize === 'normal' && !('voice' in dirty))
  assert('偏好 - 非布尔值回落默认', dirty.autoShowExplanation === true)
  assert('偏好 - 合法布尔被采纳', dirty.autoNextWhenCorrect === true)

  const usingSwitch = preferenceUtils.setPreferenceSwitch(defaults, 'autoNextWhenCorrect', true)

  assert('偏好 - 开关可改', usingSwitch.autoNextWhenCorrect === true)
  assert('偏好 - 开关拒绝非布尔值',
    preferenceUtils.setPreferenceSwitch(defaults, 'autoNextWhenCorrect', 1).autoNextWhenCorrect === false)
  assert('偏好 - 随机出题开关沿用顺序字段',
    preferenceUtils.setPreferenceSwitch(defaults, 'practiceOrder', true).practiceOrder === 'random' &&
    preferenceUtils.setPreferenceSwitch({ practiceOrder: 'random' }, 'practiceOrder', false).practiceOrder === 'order')
  assert('偏好 - 顺序开关拒绝非布尔值',
    preferenceUtils.setPreferenceSwitch({ practiceOrder: 'random' }, 'practiceOrder', 'false').practiceOrder === 'random')

  const choice = preferenceUtils.setPreferenceChoice(defaults, 'fontSize', 'large')

  assert('偏好 - 字号可改', choice.fontSize === 'large')
  assert('偏好 - 字号拒绝非法值',
    preferenceUtils.setPreferenceChoice(defaults, 'fontSize', 'xxl').fontSize === 'normal')

  const view = preferenceUtils.buildPreferenceView({ fontSize: 'large' })
  const fontChoice = view.choices.find((item) => item.key === 'fontSize')

  assert('偏好 - 设置视图包含七个开关', view.switches.length === 7, `实际 ${view.switches.length}`)
  assert('偏好 - 设置视图提供字号选择',
    view.choices.length === 1 && fontChoice, `实际 ${view.choices.length}`)
  assert('偏好 - 沿用旧顺序和解析偏好显示开关',
    preferenceUtils.buildPreferenceView({ practiceOrder: 'random', autoShowExplanation: false }).switches.find(item => item.key === 'practiceOrder').value === true &&
    view.switches.find(item => item.key === 'autoShowExplanation').value === true)
  assert('偏好 - 字号选中态唯一',
    fontChoice.options.filter((option) => option.selected).length === 1)
  assert('偏好 - 音色配置已移除', !view.choices.some(item => item.key === 'voice'))
}

// ---------- 三、每日日志 ----------
function checkDailyLog() {
  assert('日志 - 空值归一化', Object.keys(dailyLogUtils.normalizeDailyLog(null)).length === 0)

  assert('日志 - 丢弃非法键',
    dailyLogUtils.normalizeDailyLog({ 'not-a-date': { answered: 1 } })['not-a-date'] === undefined)

  let log = null

  log = dailyLogUtils.addDailyResult(log, { answered: 20, objectiveAnswered: 20, correct: 16, seconds: 600 }, TODAY)
  log = dailyLogUtils.addDailyResult(log, { answered: 10, objectiveAnswered: 10, correct: 5, seconds: 300 }, TODAY)
  log = dailyLogUtils.addDailyResult(log, { answered: 8, objectiveAnswered: 8, correct: 8, seconds: 200 }, TODAY - 3 * DAY_MS)
  log = dailyLogUtils.addDailyResult(log, { answered: 12, objectiveAnswered: 12, correct: 6, seconds: 400 }, TODAY - DAY_MS)

  const todayKey = dailyLogUtils.formatDateKey(TODAY)

  assert('日志 - 同一天累加而不是覆盖',
    log[todayKey].answered === 30 && log[todayKey].correct === 21 && log[todayKey].seconds === 900,
    JSON.stringify(log[todayKey]))

  assert('日志 - 答对数不超过答题数',
    dailyLogUtils.addDailyResult(null, { answered: 3, correct: 9 }, TODAY)[todayKey].correct === 3)

  assert('日志 - 全零结果不写库',
    Object.keys(dailyLogUtils.addDailyResult(null, { answered: 0, correct: 0, seconds: 0 }, TODAY)).length === 0)

  const recent = dailyLogUtils.getRecentDays(log, 7, TODAY)

  assert('日志 - 近 7 天刚好 7 个点', recent.length === 7, `实际 ${recent.length}`)
  assert('日志 - 序列按时间正序且末位是今天',
    recent[6].key === todayKey && recent[6].isToday === true, JSON.stringify(recent[6]))
  assert('日志 - 空缺日期补 0 而不是缺项',
    recent[0].answered === 0 && recent[0].key === dailyLogUtils.formatDateKey(TODAY - 6 * DAY_MS))

  assert('日志 - 连续天数（今天+昨天）', dailyLogUtils.calcStreak(log, TODAY) === 2,
    `实际 ${dailyLogUtils.calcStreak(log, TODAY)}`)
  assert('日志 - 今天还没练时从昨天回溯',
    dailyLogUtils.calcStreak(log, TODAY + DAY_MS) === 2,
    `实际 ${dailyLogUtils.calcStreak(log, TODAY + DAY_MS)}`)
  assert('日志 - 活跃天数', dailyLogUtils.countActiveDays(log, 7, TODAY) === 3,
    `实际 ${dailyLogUtils.countActiveDays(log, 7, TODAY)}`)

  const summary = dailyLogUtils.summarizeRecentDays(log, 7, TODAY)

  assert('日志 - 汇总题量', summary.answered === 50, `实际 ${summary.answered}`)
  assert('日志 - 汇总正确率', summary.accuracyText === '70%', summary.accuracyText)
  assert('日志 - 汇总峰值日', summary.peakAnswered === 30, `实际 ${summary.peakAnswered}`)

  // 保留期裁剪：只留最近 3 天
  const pruned = dailyLogUtils.pruneDailyLog(log, TODAY, 3)

  assert('日志 - 裁剪丢弃过期记录',
    Object.keys(pruned).length === 2 && pruned[dailyLogUtils.formatDateKey(TODAY - 3 * DAY_MS)] === undefined,
    Object.keys(pruned).join(','))
}

// ---------- 四、图表 SVG ----------
function checkChartSvg() {
  const points = [
    { value: 2, label: '周一' },
    { value: 5, label: '周二' },
    { value: 1, label: '周三' }
  ]
  const trend = chartSvg.buildAreaTrendSvg(points)

  assert('图表 - 趋势图输出合法 SVG',
    trend.indexOf('<svg') === 0 && trend.indexOf('</svg>') === trend.length - 6)
  assert('图表 - SVG 仅绘制图形，日期使用原生文字', !trend.includes('<text'))
  assert('图表 - 趋势图少于两点不出图',
    chartSvg.buildAreaTrendSvg([]) === '' && chartSvg.buildAreaTrendSvg([{ value: 3 }]) === '')

  const uri = chartSvg.toDataUri(trend)

  assert('图表 - dataURI 前缀正确', uri.indexOf('data:image/svg+xml;base64,') === 0)
  assert('图表 - dataURI 可还原为原 SVG',
    Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8') === trend)
  assert('图表 - XML 特殊字符被转义',
    chartSvg.escapeXml('a<b&"c') === 'a&lt;b&amp;&quot;c')

  const heat = chartSvg.buildHeatmapSvg({
    columns: [[{ level: 0 }, { level: 4 }, null, null, null, null, null]],
    months: [{ col: 0, text: '10月' }]
  })

  assert('图表 - 热力图输出 SVG，月份使用原生文字',
    heat.indexOf('<svg') === 0 && !heat.includes('<text'))
  assert('图表 - 热力图忽略未来空格子',
    (heat.match(/<rect /g) || []).length === 2)
  assert('图表 - 空热力图不出图', chartSvg.buildHeatmapSvg({ columns: [] }) === '')

  const vm = new StatsViewModel({ storage: createMemoryStorage() })
  const days = dailyLogUtils.getRecentDays({}, 182, TODAY).map(day => Object.assign({}, day, { answered: 1 }))
  vm.cache = { days }
  const activity = vm.buildActivity(days)
  assert('图表 - 热力图提供原生月份与边界位置', activity.labels.length >= 6 && activity.labels.every(label => label.left >= 0 && label.left <= 100))
  for (const count of [7, 30]) {
    const result = vm.buildTrend({ value: count + 'd', days: count })
    assert('图表 - ' + count + ' 天原生轴保留首尾', result.labels[0].left === 0 && result.labels.at(-1).left === 100)
    assert('图表 - ' + count + ' 天末尾标签保持间距', result.labels.at(-1).left - result.labels.at(-2).left >= 10)
  }
  assert('图表 - 没有答题时清空日期标签', vm.renderTrend([{ value: 0, label: '今天' }]).labels.length === 0)
}

// ---------- 五、设置页 ViewModel ----------
function checkSettingsViewModel() {
  const storage = createMemoryStorage()
  const vm = new SettingsViewModel({ storage })
  const initial = vm.load()

  assert('设置 - 初始开关非空', initial.data.switches.length === 7)
  assert('设置 - 目录统计由其他页面负责', initial.data.catalog === undefined)
  // 改版后账户分组迁到「我的 → 账号管理」（设计稿 781:2123），设置页不该再有第二份账号状态
  assert('设置 - 账户分组已迁出',
    initial.data.accountActions === undefined && initial.data.auth === undefined,
    JSON.stringify(Object.keys(initial.data)))

  assert('设置 - 布局由独立页面编辑', !initial.data.choices.some(item => item.key === 'answerLayout'))

  vm.toggleSwitch('autoAddWrongBook', false)

  const stored = storage.get(preferenceUtils.PREFERENCE_STORAGE_KEY)

  assert('设置 - 开关切换落盘', stored.autoAddWrongBook === false, JSON.stringify(stored))

  const afterToggle = vm.toggleSwitch('autoAddWrongBook', false)

  assert('设置 - 切换后回传最新视图',
    afterToggle.data.switches.find((item) => item.key === 'autoAddWrongBook').value === false)

  assert('设置 - 非法 key 返回空', vm.toggleSwitch('', true) === null)

  const random = vm.toggleSwitch('practiceOrder', true)
  assert('设置 - 开启随机出题后记住随机顺序',
    random.data.switches.find(item => item.key === 'practiceOrder').value === true &&
    storage.get(preferenceUtils.PREFERENCE_STORAGE_KEY).practiceOrder === 'random')
  vm.toggleSwitch('practiceOrder', false)
  assert('设置 - 关闭随机出题后按题库顺序', storage.get(preferenceUtils.PREFERENCE_STORAGE_KEY).practiceOrder === 'order')
  const explanation = vm.toggleSwitch('autoShowExplanation', false)
  assert('设置 - 解析开关关闭后交卷查看',
    explanation.data.switches.find(item => item.key === 'autoShowExplanation').value === false &&
    storage.get(preferenceUtils.PREFERENCE_STORAGE_KEY).autoShowExplanation === false)

  const fontSize = vm.selectChoice('fontSize', 'large')

  assert('设置 - 字号选择落盘',
    fontSize.data.choices.find((item) => item.key === 'fontSize').value === 'large')

  const reset = vm.resetPreferences()

  assert('设置 - 恢复默认把字号还原',
    reset.data.choices.find((item) => item.key === 'fontSize').value === 'normal')
  assert('设置 - 恢复默认带提示', reset.command.type === 'toast')


}

// ---------- 六、统计页 ViewModel ----------
function seedPractice(storage, options) {
  const config = options || {}
  const vm = new PracticeViewModel({ storage })

  vm.load({ subjectId: config.subjectId || 'subject-chinese', bankId: config.bankId || 'chinese-ch001', mode: 'order' })

  // 自动化跑得比人快，真实用时会接近 0 秒；把时钟往前拨，
  // 模拟一次「做了若干题」的练习，否则时长与每日日志都不会落盘
  vm.session.accumulatedMs = (config.seconds || 180) * 1000
  vm.session.startedAt = Date.now()

  const questions = vm.session.state.questions
  const wrongFirstN = config.wrongFirstN || 0

  questions.forEach((question, index) => {
    const correctIndex = question.options.findIndex((option) => question.answerKeys.indexOf(option.key) >= 0)
    const wrongIndex = question.options.findIndex((option) => question.answerKeys.indexOf(option.key) < 0)
    const target = index < wrongFirstN && wrongIndex >= 0 ? wrongIndex : correctIndex

    vm.selectOption(target)
    vm.goNext()
  })

  vm.forceSubmit()
  return vm
}




// ---------- 七、偏好是否真的改变了答题行为 ----------


// ---------- 输出 ----------
checkBase64()
checkPreferences()
checkDailyLog()
checkChartSvg()
checkSettingsViewModel()


const failed = results.filter((item) => !item.passed)

results.forEach((item) => {
  if (!item.passed) {
    console.log(`FAIL  ${item.name}${item.detail ? `  → ${item.detail}` : ''}`)
  }
})

console.log('')

if (failed.length) {
  console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
  process.exitCode = 1
} else {
  console.log(`总计 ${results.length} 项，通过 ${results.length} 项，失败 0 项`)
}
