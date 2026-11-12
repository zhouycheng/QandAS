/**
 * 考试倒计时（设置页 → 首页）全链路 —— Node 自检脚本。
 * 运行：node apps/miniapp/tests/exam-countdown.check.js
 *
 * 覆盖列表增删改、旧数据转换、保存失败和首页选择最近一场考试。
 */
const path = require('path')

const MINIPROGRAM = path.resolve(__dirname, '../miniprogram')
const examCountdown = require(path.join(MINIPROGRAM, 'utils/exam-countdown.js'))
const preferences = require(path.join(MINIPROGRAM, 'utils/preferences.js'))
const { ExamCountdownViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/exam-countdown-viewmodel.js'))
const { SubjectListViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/subject-list-viewmodel.js'))
const practiceRepository = require(path.join(MINIPROGRAM, 'repositories/practice-repository.js'))

const results = []

function assert(name, condition, detail) {
  results.push({ name, passed: !!condition, detail: condition ? '' : detail || '' })
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

/** 用真实的 practice-repository 驱动，才能验到「落盘 → 读回」这一步 */
function createViewModel(storage) {
  return new ExamCountdownViewModel({ storage, now: () => NOW })
}

function createHomeViewModel(storage) {
  return new SubjectListViewModel({ repository: practiceRepository, storage })
}

const at = (y, m, d, hour = 10) => new Date(y, m - 1, d, hour, 0, 0, 0).getTime()
const NOW = at(2026, 12, 1)

/**
 * 设置页 ViewModel 不注入时间，走的是真实 Date.now()。
 * 所以跨页断言不能写死天数，必须按运行当天算，否则换个日期跑就红了。
 */
function daysTo(dateKey) {
  return examCountdown.diffCalendarDays(Date.now(), examCountdown.parseDateKey(dateKey))
}

// ---------- 一、偏好层 ----------

function checkPreferences() {
  const defaults = preferences.normalizePreferences(null)

  assert('偏好 - 默认不含考试名称', defaults.examName === '')
  assert('偏好 - 默认不含考试日期', defaults.examDate === '')

  // 补齐：老用户存的是没有这两个键的旧对象
  const filled = preferences.normalizePreferences({ fontSize: 'large' })
  assert('偏好 - 旧数据自动补齐 examName', filled.examName === '')
  assert('偏好 - 补齐时不影响已有字段', filled.fontSize === 'large')

  // 脏数据：类型不对时必须退回空串，不能把 [object Object] 渲染到卡片上
  assert('偏好 - 非字符串 examName 归一化为空',
    preferences.normalizePreferences({ examName: { a: 1 } }).examName === '')
  assert('偏好 - 非字符串 examDate 归一化为空',
    preferences.normalizePreferences({ examDate: 20261210 }).examDate === '')

  const set = preferences.setPreferenceText(preferences.normalizePreferences(null), 'examName', '研究生入学考试')
  assert('偏好 - setPreferenceText 写入名称', set.examName === '研究生入学考试')
  assert('偏好 - setPreferenceText 不破坏其它字段', typeof set.fontSize === 'string')

  // 只允许白名单键被写入，防止页面把任意字符串塞进偏好
  const blocked = preferences.setPreferenceText(preferences.normalizePreferences(null), 'unknownKey', 'x')
  assert('偏好 - 非白名单键不被写入', blocked.unknownKey === undefined)

  assert('偏好 - 文本键白名单含两个考试字段',
    preferences.TEXT_PREFERENCE_KEYS.indexOf('examName') >= 0 &&
    preferences.TEXT_PREFERENCE_KEYS.indexOf('examDate') >= 0)
}

// ---------- 二、日期边界 ----------

function checkDateBoundaries() {
  assert('边界 - 今天考试算 0 天',
    examCountdown.buildExamCountdown({ examName: 'A', examDate: '2026-12-01' }, NOW).daysLeft === 0)
  assert('边界 - 明天考试算 1 天',
    examCountdown.buildExamCountdown({ examName: 'A', examDate: '2026-12-02' }, NOW).daysLeft === 1)
  assert('边界 - 昨天考试标记为已过去',
    examCountdown.buildExamCountdown({ examName: 'A', examDate: '2026-11-30' }, NOW).isPast === true)

  // 跨年
  assert('边界 - 跨年倒计时正确',
    examCountdown.buildExamCountdown({ examName: 'A', examDate: '2027-01-01' }, NOW).daysLeft === 31)

  // 闰年 2 月 29 日
  assert('边界 - 闰年 2 月 29 日合法',
    examCountdown.buildExamCountdown({ examName: 'A', examDate: '2028-02-29' }, at(2028, 1, 1)).configured === true)

  const invalid = ['2026-02-30', '2026-13-01', '2026-00-10', '20261201', '2026/12/01', '']
  const wronglyAccepted = invalid.filter((date) =>
    examCountdown.buildExamCountdown({ examName: 'A', examDate: date }, NOW).configured === true)

  assert('边界 - 非法日期一律视为未设置', wronglyAccepted.length === 0, wronglyAccepted.join(', '))
  assert('边界 - 校验器拒绝早于今天的日期',
    examCountdown.validateExamInput('A', '2026-11-30', NOW).ok === false)
  assert('边界 - 校验器接受今天', examCountdown.validateExamInput('A', '2026-12-01', NOW).ok === true)

  // toDateKey 必须补零，否则 '2026-1-5' 会让 picker 的 start 失效
  assert('边界 - toDateKey 补零', examCountdown.toDateKey(at(2026, 1, 5)) === '2026-01-05',
    examCountdown.toDateKey(at(2026, 1, 5)))

  // 进度条：30 天准备期折算，不应出现负数或超过 100
  assert('边界 - 进度不超过 100',
    examCountdown.buildExamCountdown({ examName: 'A', examDate: '2027-12-01' }, NOW).progressPercent === 100)
  assert('边界 - 进度不低于 0',
    examCountdown.buildExamCountdown({ examName: 'A', examDate: '2026-11-01' }, NOW).progressPercent === 0)
}

// ---------- 三、设置页链路 ----------

function checkSettingsFlow() {
  const storage = createMemoryStorage()
  const vm = createViewModel(storage)
  assert('列表 - 初始为空', vm.load().data.exams.length === 0)
  assert('编辑 - 新建表单保存禁用', vm.openEditor().data.canSave === false)
  vm.setDraftName(' 研究生入学考试 ')
  assert('编辑 - 未选日期时保存禁用', vm.canSave() === false)
  assert('编辑 - 未完成表单不落盘', Object.keys(storage.raw).length === 0)
  vm.setDraftDate('2026-12-20')
  let result = vm.saveExam()
  assert('新增 - 完整表单保存成功', result.command.title === '倒计时已添加')
  const firstId = result.data.exams[0].id
  assert('新增 - 名称去除首尾空格', result.data.exams[0].examName === '研究生入学考试')
  assert('新增 - 保存后关闭表单', result.data.editorVisible === false && result.data.canSave === false)
  assert('新增 - 连续点击保存不重复添加', !vm.saveExam().data && vm.load().data.exams.length === 1)

  vm.openEditor(); vm.setDraftName('期末考试'); vm.setDraftDate('2026-12-10'); vm.saveExam()
  let exams = vm.load().data.exams
  const secondId = exams[0].id
  assert('列表 - 多场考试按最近日期排序', exams.length === 2 && exams[0].examName === '期末考试')
  assert('列表 - 每张卡片有独立天数', exams[0].daysLeft === 9 && exams[1].daysLeft === 19)
  assert('编辑 - 回显已有名称日期', vm.openEditor(firstId).data.draftDate === '2026-12-20')
  assert('编辑 - 未修改时保存禁用', vm.canSave() === false)
  vm.setDraftName('硕士入学考试'); vm.setDraftDate('2026-12-05'); result = vm.saveExam()
  exams = result.data.exams
  assert('编辑 - 更新同一卡片并重新排序', exams.length === 2 && exams[0].id === firstId && exams[0].examName === '硕士入学考试')

  vm.openEditor(firstId); vm.setDraftName('不保存的名称'); vm.closeEditor()
  assert('编辑 - 取消后保留已存数据', vm.load().data.exams[0].examName === '硕士入学考试')
  vm.openEditor(); vm.setDraftName('新考试'); vm.setDraftDate('2026-11-30')
  assert('校验 - 新增过去的日期显示错误', vm.saveExam().data.formError === '考试日期不能早于今天')
  assert('校验 - 失败不添加卡片', vm.load().data.exams.length === 2)

  const originalSet = storage.set
  storage.set = () => { throw new Error('full') }
  vm.setDraftDate('2026-12-25')
  assert('失败 - 保存错误保留草稿供重试', !!vm.saveExam().data.formError && vm.canSave())
  assert('失败 - 新增失败保留原列表', vm.load().data.exams.length === 2)
  assert('失败 - 删除失败保留原列表', !!vm.deleteExam(firstId).command && vm.load().data.exams.length === 2)
  storage.set = originalSet
  vm.saveExam()
  assert('失败 - 重试只添加一次', vm.load().data.exams.length === 3)
  vm.deleteExam(firstId)
  assert('删除 - 仅删除指定卡片', !vm.load().data.exams.some(item => item.id === firstId) && vm.load().data.exams.some(item => item.id === secondId))
  assert('删除 - 已删除卡片不可继续编辑', !!vm.openEditor(firstId).command)

  const beforeReset = JSON.stringify(practiceRepository.getPreferences(storage).examCountdowns)
  practiceRepository.resetPreferences(storage)
  assert('偏好 - 恢复答题默认保留全部倒计时', JSON.stringify(practiceRepository.getPreferences(storage).examCountdowns) === beforeReset)
}

// ---------- 四、设置页 → 首页 ----------

function checkCrossPage() {
  const storage = createMemoryStorage()
  const settings = createViewModel(storage)

  settings.openEditor(); settings.setDraftName('期末考试'); settings.setDraftDate('2026-12-15'); settings.saveExam()

  // 首页是另一个 ViewModel，只能从 storage 读回 —— 验的就是这条链路
  const home = createHomeViewModel(storage).load()
  assert('跨页 - 首页读到设置页写入的考试', home.data.exam.configured === true)
  assert('跨页 - 首页天数与设置页一致', home.data.exam.daysLeft === daysTo('2026-12-15'),
    `实际 ${home.data.exam.daysLeft}，期望 ${daysTo('2026-12-15')}`)
  assert('跨页 - 首页标题含考试名与日期', home.data.exam.examName === '期末考试')

  // 只有日期没有名称时，首页不能显示一个没有名字的倒计时
  const dateOnlyStorage = createMemoryStorage({
    qandaPreferences: { examName: '', examDate: '2026-12-15' }
  })
  const dateOnlyHome = createHomeViewModel(dateOnlyStorage).load().data.exam

  assert('跨页 - 只有日期时首页不显示倒计时', dateOnlyHome.configured === false)
  assert('跨页 - 只有日期时首页不出天数', dateOnlyHome.dayText === '')

  // 清空后首页必须立刻回到引导态，不能残留旧天数
  settings.deleteExam(settings.load().data.exams[0].id)
  const homeAfter = createHomeViewModel(storage).load()
  assert('跨页 - 清除后首页回到未配置', homeAfter.data.exam.configured === false)
  assert('跨页 - 清除后首页不显示天数', homeAfter.data.exam.dayText === '')

  assert('跨页 - 未配置时提供设置入口',
    homeAfter.data.exam.statusText === '去设置', homeAfter.data.exam.statusText)
}

function checkSavedSelection() {
  const storage = createMemoryStorage({ qandaPreferences: { examCountdowns: [{ id: 'saved', examName: '已存考试', examDate: '2026-12-20' }], fontSize: 'large' } })
  const vm = createViewModel(storage)
  let exams = vm.load().data.exams
  assert('列表 - 读取已存考试', exams.length === 1 && exams[0].examName === '已存考试')
  vm.openEditor(exams[0].id); vm.setDraftName('考试更新'); vm.saveExam()
  assert('列表 - 编辑后保留其它偏好', storage.raw.qandaPreferences.fontSize === 'large')
  assert('列表 - 删除后保持空列表', vm.deleteExam(exams[0].id).data.exams.length === 0 && new ExamCountdownViewModel({ storage }).load().data.exams.length === 0)

  const list = [{ id: 'past', examName: '已考', examDate: '2026-11-30' }, { id: 'later', examName: '晚一些', examDate: '2026-12-20' }, { id: 'today', examName: '今天', examDate: '2026-12-01' }]
  assert('首页 - 今天的考试优先且跳过过去日期', examCountdown.selectHomeExam(list, NOW).id === 'today')
  assert('首页 - 明天自动切换下一场', examCountdown.selectHomeExam(list, at(2026, 12, 2)).id === 'later')
  assert('首页 - 全部结束时显示最近结束一场', examCountdown.selectHomeExam(list, at(2027, 1, 1)).id === 'later')
  const dirty = examCountdown.normalizeExamList([null, { examName: 123, examDate: '2026-12-01' }, ...list, { ...list[0], examName: '重复标识' }])
  assert('列表 - 过滤无效记录且标识唯一', dirty.length === 4 && new Set(dirty.map(item => item.id)).size === dirty.length)

  const past = createMemoryStorage({ qandaPreferences: { examCountdowns: [list[0]] } })
  const pastVm = createViewModel(past)
  pastVm.openEditor('past'); pastVm.setDraftName('已结束考试新名称')
  assert('编辑 - 已结束考试可以只改名称', pastVm.saveExam().data.exams[0].examName === '已结束考试新名称')
}

// ---------- 五、脏数据不崩 ----------

function checkDirtyData() {
  const cases = [
    { label: '偏好是字符串', value: 'oops' },
    { label: '偏好是数组', value: [] },
    { label: 'examName 是数字', value: { examName: 123, examDate: 456 } },
    { label: 'examDate 是过去', value: { examName: 'A', examDate: '2020-01-01' } }
  ]

  cases.forEach((item) => {
    const storage = createMemoryStorage({ qandaPreferences: item.value })
    let data = null
    let threw = false

    try {
      data = createHomeViewModel(storage).load().data
    } catch (error) {
      threw = true
    }

    assert(`脏数据 - ${item.label} 时首页不崩`, threw === false)
    assert(`脏数据 - ${item.label} 时 exam 仍是可渲染对象`,
      data && data.exam && typeof data.exam.title === 'string' && typeof data.exam.dayText === 'string')
  })

  // 过去日期：显示「已结束」而不是负数天
  const pastStorage = createMemoryStorage({
    qandaPreferences: { examCountdowns: [{ id: 'past', examName: 'A', examDate: '2020-01-01' }] }
  })
  const pastExam = createHomeViewModel(pastStorage).load().data.exam

  assert('脏数据 - 过去日期显示「已结束」而不是负数',
    pastExam.dayText === '已结束', pastExam.dayText)
}

// ---------- 输出 ----------

checkPreferences()
checkDateBoundaries()
checkSettingsFlow()
checkCrossPage()
checkSavedSelection()
checkDirtyData()

const failed = results.filter((item) => !item.passed)

results.forEach((item) => {
  if (!item.passed) {
    console.log(`FAIL  ${item.name}${item.detail ? ` —— ${item.detail}` : ''}`)
  }
})

console.log(`\n考试倒计时自检：总计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)

if (failed.length) {
  process.exitCode = 1
}
