const assert = require('node:assert/strict')
const { allocateHeights, viewportHeight, resetScroll } = require('../miniprogram/utils/practice-layout.js')

assert.deepEqual(allocateHeights({ height: 1000 }).heights, { material: 0, stem: 500, response: 500 })
assert.deepEqual(allocateHeights({ height: 1000, material: true }).heights, { material: 300, stem: 350, response: 350 })
assert.deepEqual(allocateHeights({ height: 1000, material: true, response: false }).heights, { material: 300, stem: 700, response: 0 })
assert.deepEqual(allocateHeights({ height: 1000, material: true, contentHeights: { material: 80, stem: 1000, response: 1000 } }).heights,
  { material: 300, stem: 350, response: 350 }, '短内容保持分区高度')
assert.deepEqual(allocateHeights({ height: 1000, material: true, contentHeights: { material: 2000, stem: 40, response: 50 } }).heights,
  { material: 300, stem: 350, response: 350 }, '长内容在固定区内滚动')
assert.deepEqual(allocateHeights({ height: 90, material: true, keyboard: true }).heights,
  { material: 0, stem: 0, response: 90 }, '小屏键盘优先输入')
assert.deepEqual(allocateHeights({ height: 90, response: false, keyboard: true }).heights,
  { material: 0, stem: 90, response: 0 }, '填空保留题干输入')

for (const height of [0, 1, 59, 120, 289, 400, 667, 932]) {
  for (const material of [false, true]) for (const response of [false, true]) {
    const { heights, overflow } = allocateHeights({ height, material, response, contentHeights: { material: 3000, stem: 2000, response: 3000 } })
    assert(Object.values(heights).every(value => value >= 0 && Number.isInteger(value)))
    assert(Object.values(heights).reduce((a, b) => a + b, 0) <= height)
    assert(heights.material <= Math.floor(height * 0.45))
    assert.equal(overflow.material, heights.material > 0)
  }
}
assert.equal(viewportHeight(667, 667, 300), 367, '键盘覆盖窗口')
assert.equal(viewportHeight(367, 667, 300), 367, '窗口已缩小，不重复扣减')
assert.equal(viewportHeight(667, 667, 0), 667)

const first = { material: { revisionId: 'm1' } }, same = { material: { revisionId: 'm1' } }, other = { material: { revisionId: 'm2' } }
const controls = { material: 0, stem: 0, response: 0 }
const positions = { material: 180, stem: 90, response: 100 }
assert.deepEqual(resetScroll(first, same, controls, positions), { material: 180, stem: 0.01, response: 0.01 })
assert.equal(resetScroll(first, other, controls, positions).material, 0.01)
assert.equal(resetScroll(first, null, controls, positions).material, 0.01)

let definition
const priorPage = global.Page, priorWx = global.wx
global.Page = value => { definition = value }
let windowInfo = { windowWidth: 375, windowHeight: 667 }
global.wx = { getWindowInfo: () => windowInfo }
require('../miniprogram/page/practice/index.js')
function page() {
  return Object.assign({}, definition, {
    data: { ...JSON.parse(JSON.stringify(definition.data)), fixedLayout: true },
    setData(patch, done) { Object.assign(this.data, patch); if (done) done() },
    pageVisible: true,
    viewModel: {},
    observeSaveStatus() {},
    applyViewModelEffects() {},
    clearAutoAdvance() {}
  })
}
try {
  const subject = page()
  subject.updateWindowHeight()
  subject.onAnswerFocus({ detail: {} })
  windowInfo = { windowWidth: 375, windowHeight: 367 }
  subject.updateWindowHeight()
  subject.onKeyboardHeight({ detail: { height: 300 } })
  assert.equal(subject.data.practiceWindowHeight, 367, 'resize 先到达也保留键盘前的窗口高度')
  subject.onKeyboardHeight({ detail: { height: 0 } })
  windowInfo = { windowWidth: 375, windowHeight: 667 }
  subject.updateWindowHeight()
  assert.equal(subject.data.practiceWindowHeight, 667)
  clearTimeout(subject.measureTimer)

  let measurements = 0
  subject.scheduleMeasure = () => { measurements++ }
  subject.data.currentQuestion = first
  subject.panePositions = positions
  subject.lastQuestionIndex = 0
  subject.applyViewModelResult({ data: { currentIndex: 1, currentQuestion: same } })
  assert.equal(subject.data.paneScroll.material, 180)
  subject.applyViewModelResult({ data: { currentIndex: 2, currentQuestion: other } })
  assert(subject.data.paneScroll.material < 1)
  const before = measurements
  subject.applyViewModelResult({ data: { timerSeconds: 42, timerText: '00:42' } })
  assert.equal(measurements, before, '计时刷新不测量布局')
  subject.answerFocused = true
  subject.data.answerText = '原生输入'
  subject.applyViewModelResult({ data: { answerText: '旧值', blankInputs: [], timerText: '00:41' } })
  assert.equal(subject.data.answerText, '原生输入', '聚焦期间保持原生输入')

  const measured = page()
  measured.data.currentQuestion = { material: first.material, isFillBlank: false }
  measured.createSelectorQuery = () => {
    const query = { select() { return query }, selectAll() { return query }, fields() { return query }, boundingClientRect() { return query }, exec(done) {
      done([{ height: 600, 'padding-top': '12px', 'padding-bottom': '12px', 'row-gap': '12px' }, [{ height: 24 }, { height: 36 }],
        ['material', 'stem', 'response'].map(pane => ({ dataset: { pane }, height: 3000 }))])
    } }
    return query
  }
  measured.measurePanes()
  assert.deepEqual(measured.data.paneHeights, { material: 140, stem: 163, response: 165 })
  assert(Object.values(measured.data.paneHeights).reduce((a, b) => a + b, 0) + 24 + 60 + 48 <= 600, '各区、模块间距及固定内容不突破容器')
  measured.keyboardScrollRestore = { material: 180, stem: 40, response: 70, analysis: 20 }
  measured.measurePanes()
  assert.equal(measured.data.paneScroll.material, 180, '键盘收起后恢复材料阅读位置')
  assert.equal(measured.keyboardScrollRestore, null)

  const compact = page()
  compact.keyboardVisible = true
  compact.data.currentQuestion = { isShortAnswer: true }
  compact.scheduleMeasure = () => {}
  compact.createSelectorQuery = () => {
    const query = { select() { return query }, selectAll() { return query }, fields() { return query }, boundingClientRect() { return query }, exec(done) {
      done([{ height: 140, 'padding-top': '12px', 'padding-bottom': '12px', 'row-gap': '12px' },
        [{ height: 20 }, { height: compact.data.keyboardCompact ? 0 : 80 }], [{ dataset: { pane: 'stem' }, height: 300 }]])
    } }
    return query
  }
  compact.measurePanes()
  assert.equal(compact.data.keyboardCompact, true, '极小键盘空间临时收起工具栏')
  compact.measurePanes()
  assert(compact.data.paneHeights.response >= 64, '保留可输入的区域')

  const matrix = page()
  for (const [width, screen] of [[320, 568], [375, 667], [390, 844], [430, 932]]) for (const font of [14, 18, 20, 22, 24]) {
    const gap = 24 * width / 750
    const fixed = 44 + (font === 18 && width === 320 ? 80 : 36)
    const bodyHeight = screen - 98 - 88
    matrix.data.currentQuestion = { material: first.material, isFillBlank: false }
    matrix.data.shouldRevealAnswer = true
    matrix.createSelectorQuery = () => {
      const query = { select() { return query }, selectAll() { return query }, fields() { return query }, boundingClientRect() { return query }, exec(done) {
        done([{ height: bodyHeight, 'padding-top': gap + 'px', 'padding-bottom': gap + 'px', 'row-gap': gap + 'px' }, [{ height: fixed }],
          ['material', 'stem', 'response'].map(pane => ({ dataset: { pane }, height: 5000 * font / 14 }))])
      } }
      return query
    }
    matrix.measurePanes()
    const used = Object.values(matrix.data.paneHeights).reduce((a, b) => a + b, 0)
    assert(used + fixed + gap * 6 <= bodyHeight, `${width}×${screen}/${font}px 分区保持在屏内`)
    assert(Object.values(matrix.data.paneHeights).every(value => value > 0), '普通阅读状态三个区均可见')
  }
} finally {
  global.Page = priorPage
  global.wx = priorWx
}

const priorComponent = global.Component
let component
global.Component = value => { component = value }
require('../miniprogram/components/rich-content/index.js')
global.Component = priorComponent
const events = []
let returnRects
const rich = Object.assign({ properties: { managedKeyboard: true }, triggerEvent: (name, detail) => events.push({ name, detail }), createSelectorQuery() {
  const query = { select() { return query }, boundingClientRect() { return query }, exec(done) { returnRects = done } }
  return query
} }, component.methods)
rich.focusBlank({ currentTarget: { dataset: { index: 1 } } })
returnRects([{ top: 10 }, { top: 250, height: 30 }])
assert.deepEqual(events.at(-1), { name: 'blankfocus', detail: { offsetTop: 240, height: 30 } })
rich.blurBlank()
const afterBlur = events.length
returnRects([{ top: 10 }, { top: 250, height: 30 }])
assert.equal(events.length, afterBlur, '迟到的测量不会恢复已失去的焦点')
console.log('practice viewport passed: allocation, material cap, keyboard ordering, scroll reset, sparse updates')
