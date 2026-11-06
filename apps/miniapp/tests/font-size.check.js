/**
 * 题目字号 —— Node 自检脚本。
 * 运行：node apps/miniapp/tests/font-size.check.js
 *
 * 覆盖五档阅读字号、实时预览、落盘失败恢复及答题与详情页的共享样式。
 */
const fs = require('fs')
const path = require('path')

const MINIPROGRAM = path.resolve(__dirname, '../miniprogram')
const preferenceUtils = require(path.join(MINIPROGRAM, 'utils/preferences.js'))
const { SettingsViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/settings-viewmodel.js'))
const { QuestionDetailViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/question-detail-viewmodel.js'))
const { PracticeSession } = require(path.join(MINIPROGRAM, 'models/practice-session.js'))

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
      if (this.full) throw new Error('存储已满')
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

function readFile(relativePath) {
  return fs.readFileSync(path.join(MINIPROGRAM, relativePath), 'utf8')
}

const { readingSizes } = require('../miniprogram/utils/design-tokens.js')
const controls = readFile('styles/controls.wxss')

function hasReadingSize(wxss, target) {
  const pattern = new RegExp(`\\.${target}\\s*\\{[^}]*?font-size:\\s*var\\(--reading-size,\\s*var\\(--reading-normal\\)\\)`)
  return pattern.test(wxss)
}

function pickFontSize(wxss, scale, target) {
  return hasReadingSize(wxss, target) && controls.includes(`.font-${scale} { --reading-size: var(--reading-${scale}); }`) ? readingSizes[scale] : 0
}

function pickDefaultFontSize(wxss, target) {
  return hasReadingSize(wxss, target) ? readingSizes.normal : 0
}

// ---------- 一、偏好本身 ----------
function checkPreferences() {
  const options = preferenceUtils.FONT_SIZE_OPTIONS.map((item) => item.value).join(',')

  assert('偏好 - 字号五档齐全', options === 'small,normal,large,xlarge,xxlarge', options)
  assert('偏好 - 标准为18px，五档数值确定', JSON.stringify(Object.values(readingSizes)) === '[14,18,20,22,24]')
  assert('偏好 - 默认是标准', preferenceUtils.DEFAULT_PREFERENCES.fontSize === 'normal')
  assert('偏好 - 非法值回落标准',
    preferenceUtils.normalizePreferences({ fontSize: 'huge' }).fontSize === 'normal')
  assert('偏好 - 合法值保留',
    preferenceUtils.normalizePreferences({ fontSize: 'large' }).fontSize === 'large')
  assert('偏好 - 字号对设置页开放',
    preferenceUtils.PREFERENCE_CHOICES.find((item) => item.key === 'fontSize').available === true)
}

// ---------- 二、设置页：点了要有看得见的变化 ----------
function checkSettings() {
  const storage = createMemoryStorage()
  const vm = new SettingsViewModel({ storage })

  assert('设置 - 初始标准字号', vm.load().data.fontSize === 'normal')
  assert('设置 - 提供预览文案', !!vm.load().data.fontPreviewText)

  const large = vm.selectChoice('fontSize', 'large')

  assert('设置 - 选大后回传 large', large.data.fontSize === 'large', large.data.fontSize)
  assert('设置 - 选大后选中态跟着变',
    large.data.choices.find(item => item.key === 'fontSize').options.find((item) => item.value === 'large').selected === true)
  assert('设置 - 选大落盘',
    preferenceUtils.normalizePreferences(storage.get(preferenceUtils.PREFERENCE_STORAGE_KEY)).fontSize === 'large')

  const small = vm.selectChoice('fontSize', 'small')

  assert('设置 - 选小后回传 small', small.data.fontSize === 'small', small.data.fontSize)
  for (const [index, option] of preferenceUtils.FONT_SIZE_OPTIONS.entries()) {
    const saved = storage.get(preferenceUtils.PREFERENCE_STORAGE_KEY).fontSize
    const preview = vm.previewFont(index)
    assert('滑杆 - 实时预览 ' + option.label, preview.data.fontSize === option.value && preview.data.fontIndex === index && preview.data.fontLabel === option.label)
    assert('滑杆 - 拖动不落盘 ' + option.label, storage.get(preferenceUtils.PREFERENCE_STORAGE_KEY).fontSize === saved)
    assert('滑杆 - 松手保存 ' + option.label, vm.saveFont(index).data.fontSize === option.value && storage.get(preferenceUtils.PREFERENCE_STORAGE_KEY).fontSize === option.value)
  }
  storage.full = true
  vm.previewFont(0)
  const failed = vm.saveFont(0)
  assert('滑杆 - 保存失败恢复已保存的超大档', failed.data.fontSize === 'xxlarge' && failed.data.fontIndex === 4 && !!failed.command)
  storage.full = false
  assert('滑杆 - 拒绝非法档位', [-1, 5, 0.5, '2', NaN].every(index => vm.previewFont(index) === null && vm.saveFont(index) === null))
  assert('滑杆 - 恢复默认回到18px', vm.resetPreferences().data.fontIndex === 1)

  const wxml = readFile('page/settings/index.wxml')
  const wxss = readFile('page/settings/index.wxss')

  assert('设置 - 预览块绑了当前字号', wxml.indexOf('font-{{fontSize}}') >= 0)
  assert('设置 - 字号预览仍在偏好页面', wxml.includes('{{fontPreviewText}}'))
  assert('设置 - 滑杆先于固定高度预览', wxml.indexOf('<slider') < wxml.indexOf('class="font-preview"') && /\.font-preview\s*\{[^}]*height:\s*160px/.test(wxss))
  assert('设置 - 档位覆盖原生宽度并支持44px点击区域', /\.font-stop\.q-button\s*\{[^}]*width:\s*44px[^}]*min-height:\s*44px/.test(wxss))
  assert('设置 - 五段滑杆绑定预览与保存', wxml.includes('max="4" step="1"') && wxml.includes('bindchanging="handleFontChanging"') && wxml.includes('bindchange="handleFontChange"'))
  assert('设置 - 预览有两档字号规则',
    pickFontSize(wxss, 'small', 'font-preview-text') > 0 &&
      pickFontSize(wxss, 'large', 'font-preview-text') > 0)
}

// ---------- 三、答题页：五档共用阅读尺度 ----------
function checkPracticeScale() {
  const wxss = readFile('styles/practice.wxss')
  const wxml = readFile('page/practice/index.wxml')

  assert('答题页 - 根节点带 font-* 类', wxml.indexOf('font-{{preferences.fontSize}}') >= 0)

  // 类名随 2026-10-27 设计稿重做改成 pra-* 前缀，断言保护的行为不变
  const targets = ['pra-stem', 'pra-option-text', 'pra-explanation-text', 'res-item-stem']

  targets.forEach((target) => {
    assert(`答题页 - .${target} 五档都应用实际字号`, Object.entries(readingSizes).every(([scale, size]) => pickFontSize(wxss, scale, target) === size))
    const small = pickFontSize(wxss, 'small', target)
    const large = pickFontSize(wxss, 'large', target)
    const base = pickDefaultFontSize(wxss, target)

    assert(`答题页 - .${target} 三档都有定义`, small > 0 && large > 0 && base > 0,
      `small=${small} base=${base} large=${large}`)
    assert(`答题页 - .${target} 方向正确（小 < 标准 < 大）`, small < base && base < large,
      `small=${small} base=${base} large=${large}`)
    assert(`答题页 - .${target} 小档与大档差距 ≥ 4px`, large - small >= 4,
      `large - small = ${large - small}`)
  })

  // 会话把偏好透传给页面
  const session = new PracticeSession({
    preferences: { fontSize: 'large' },
    quiz: null
  })

  assert('答题页 - 偏好透传到视图数据',
    session.getViewData().preferences.fontSize === 'large',
    JSON.stringify(session.getViewData().preferences))
}

// ---------- 四、题目详情页也要跟着生效 ----------
function checkQuestionDetail() {
  const wxml = readFile('page/question-detail/index.wxml')
  const wxss = readFile('page/question-detail/index.wxss')

  assert('详情页 - 根节点带 font-* 类', wxml.indexOf('font-{{fontSize}}') >= 0)

  const targets = ['detail-stem', 'detail-option-text', 'explain-text']

  targets.forEach((target) => {
    const small = pickFontSize(wxss, 'small', target)
    const large = pickFontSize(wxss, 'large', target)
    const base = pickDefaultFontSize(wxss, target)

    assert(`详情页 - .${target} 三档都有定义`, small > 0 && large > 0 && base > 0,
      `small=${small} base=${base} large=${large}`)
    assert(`详情页 - .${target} 方向正确`, small < base && base < large,
      `small=${small} base=${base} large=${large}`)
  })

  const vm = new QuestionDetailViewModel({
    storage: createMemoryStorage(),
    repository: {
      getPreferences: () => ({ fontSize: 'large' })
    }
  })

  assert('详情页 - 读偏好得到当前字号', vm.readFontSize() === 'large', vm.readFontSize())
  assert('详情页 - 初始数据是标准字号',
    QuestionDetailViewModel.getInitialData().fontSize === 'normal')

  const broken = new QuestionDetailViewModel({
    storage: createMemoryStorage(),
    repository: {
      getPreferences() {
        throw new Error('storage broken')
      }
    }
  })

  assert('详情页 - 读偏好失败退回标准字号', broken.readFontSize() === 'normal', broken.readFontSize())
}

checkPreferences()
checkSettings()
checkPracticeScale()
checkQuestionDetail()

const failed = results.filter((item) => !item.passed)
const width = Math.max(...results.map((item) => item.name.length))

console.log('\n=== 题目字号自检 ===\n')

results.forEach((item) => {
  console.log(`${item.passed ? '  ✓' : '  ✗'} ${item.name.padEnd(width, ' ')}  ${item.passed ? '' : item.detail}`)
})

console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)

if (failed.length > 0) {
  process.exit(1)
}
