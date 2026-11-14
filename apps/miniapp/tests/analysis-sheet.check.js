const assert = require('node:assert/strict')
const fs = require('node:fs')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const vm = require('node:vm')
const wxs = { module: { exports: {} } }
vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/utils/analysis-drag.wxs'), 'utf8'), wxs)
const drag = wxs.module.exports
let definition
const oldPage = global.Page, oldWx = global.wx
global.Page = value => { definition = value }
global.wx = {}
require('../miniprogram/page/practice/index.js')
const page = () => Object.assign({}, definition, {
  data: { ...JSON.parse(JSON.stringify(definition.data)), legacyAnalysisEnabled: true }, pageVisible: true,
  applyViewModelResult(result) { if (result && result.data) result = { ...result, data: { ...result.data, legacyAnalysisEnabled: true } }; return definition.applyViewModelResult.call(this, result) },
  setData(patch, done) { Object.assign(this.data, patch); if (done) done() },
  viewModel: {}, scheduleMeasure() {}, observeSaveStatus() {}, applyViewModelEffects() {},
  clearAutoAdvance() { this.cleared = true }
})
function gestures(subject) {
  const state = {}, styles = {}, maskStyle = {}, calls = [], pending = []
  let previous, computedHeight
  const sheet = {
    setStyle(value) { Object.assign(styles, value) },
    getComputedStyle() { return { height: computedHeight || styles.height } }
  }
  const owner = {
    getState: () => state,
    selectComponent(selector) { return selector === '.analysis-sheet' ? sheet : { setStyle: value => Object.assign(maskStyle, value) } },
    callMethod(name, value) {
      calls.push(name)
      if (owner.defer) pending.push(() => subject[name](value))
      else subject[name](value)
    }
  }
  const api = {
    styles, maskStyle, calls, owner,
    computed(value) { computedHeight = value },
    flush() { while (pending.length) pending.shift()() },
    sync(initial = false) {
      const value = { version: subject.data.analysisSheetVersion, height: subject.data.analysisSheetHeight, offset: subject.data.analysisSheetOffset }
      drag.sync(value, initial ? undefined : previous, owner)
      previous = value
    },
    start(y) { drag.start({ touches: [{ clientY: y }] }, owner) },
    move(y) { drag.move({ touches: [{ clientY: y }] }, owner) },
    end(y) { drag.end({ changedTouches: y === undefined ? [] : [{ clientY: y }] }, owner); api.sync() },
    cancel() { drag.cancel({}, owner); api.sync() },
    tap() { drag.tap({}, owner); api.sync() }
  }
  api.sync()
  return api
}
const quiz = { bankId: 'b', questions: [
  { id: 'a', type: 'SINGLE_CHOICE', stem: '题干', options: [{ key: 'A', text: '甲' }], answerKeys: ['A'], explanation: '本题解析' },
  { id: 'b', type: 'MULTIPLE_CHOICE', isMultiple: true, stem: '多选题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKeys: ['A', 'B'], explanation: '多选解析' }
] }
try {
  assert.equal(definition.data.legacyAnalysisEnabled, false, '正式页面默认停用下拉解析备选')
  const session = new PracticeSession({ quiz, mode: 'practice', preferences: { autoOpenAnalysis: true } })
  session.reset()
  assert.equal(session.getViewData().practiceModeText, '练习模式')
  const subject = page()
  subject.applyViewModelResult({ data: session.getViewData() })
  subject.setData(subject.analysisMeasurement({ top: 88, height: 429 }))
  assert.equal(subject.data.shouldRevealAnswer, false)
  subject.setAnalysisOpen(true)
  assert.equal(subject.data.analysisSheetOpen, false, '未作答不能打开解析')
  session.selectOption(0)
  subject.applyViewModelResult({ data: session.getViewData() })
  assert.equal(subject.data.analysisSheetOpen, true, '即时反馈确认答案后自动展开')
  assert.equal(subject.data.analysisSheetHeight + subject.data.analysisSheetOffset, 214, '默认展开至内容区的一半')
  const handle = gestures(subject)
  assert.equal(handle.styles.height, '214px', '半屏从顶部呈现完整标题和正文')
  handle.start(302); handle.move(388); handle.end(388)
  assert.equal(subject.data.analysisSheetOffset, 0, '默认半屏仍可继续下拉展开')
  assert.equal(handle.styles.height, '300px')
  handle.start(400)
  const startCalls = handle.calls.length
  handle.move(340); handle.move(280)
  assert.equal(handle.styles.height, '180px', '把手跟随面板下沿调整高度')
  assert.equal(handle.styles.transition, 'none', '拖动即时跟手')
  assert.equal(handle.calls.length, startCalls, '移动帧不跨逻辑层传输')
  handle.end(280)
  assert.equal(subject.data.analysisSheetOpen, true)
  assert.equal(subject.data.analysisSheetOffset, -120, '松手停在当前位置')
  handle.tap()
  assert.equal(subject.data.analysisSheetOffset, -120, '拖动后的 tap 不切换面板')
  assert.equal(subject.cleared, true, '操作解析取消自动跳题')
  subject.applyViewModelResult({ data: { elapsedText: '00:20' } })
  handle.sync()
  assert.equal(subject.data.analysisSheetOffset, -120, '计时刷新保留停靠位置')
  handle.start(280); handle.move(240); handle.end(240)
  assert.equal(subject.data.analysisSheetOffset, -160, '再次上推从上次停靠位置继续')
  handle.start(240); handle.move(999); handle.end(999)
  assert.equal(subject.data.analysisSheetOffset, 0, '拖动不会超出展开边界')
  assert.equal(subject.data.analysisSheetOpen, true, '下拉把手可以重新展开')
  handle.tap()
  assert.equal(subject.data.analysisSheetOpen, true, '拖动结束后的 tap 不重复切换')
  handle.start(400); handle.move(360); handle.cancel()
  assert.equal(subject.data.analysisSheetOffset, 0, '取消手势恢复开始状态')
  handle.start(400); handle.move(240); handle.end(240)
  handle.start(240); handle.move(210); handle.cancel()
  assert.equal(subject.data.analysisSheetOffset, -160, '取消手势恢复中间停靠位置')
  handle.start(240); handle.move(133); handle.end(133)
  assert.equal(subject.data.analysisSheetOffset, -267, '距离顶部 33px 仍停在原处')
  handle.start(133); handle.move(129); handle.end(129)
  assert.equal(subject.data.analysisSheetOffset, -300, '距离顶部 32px 内吸附收起')
  assert.match(handle.styles.transition, /180ms/)
  assert.equal(handle.maskStyle['pointer-events'], 'none', '收起后恢复题目交互')
  handle.start(100); handle.move(140); handle.end(140)
  assert.equal(subject.data.analysisSheetOffset, -260, '从收起态下拉也可停在中间')
  assert.equal(handle.maskStyle['pointer-events'], 'auto')
  handle.start(140); handle.move(160); handle.end()
  assert.equal(subject.data.analysisSheetOffset, -240, '结束事件缺少坐标时保留最后位置')
  handle.start(160); handle.move(80)
  drag.move({ touches: [{ clientY: 70 }, { clientY: 80 }] }, handle.owner)
  assert.equal(subject.data.analysisSheetOffset, -240, '多指中断恢复手势前的位置')
  handle.start(160); handle.move(-900); handle.end(-900)
  assert.equal(subject.data.analysisSheetOffset, -300, '上推限制在顶部边界')
  handle.start(100); handle.end(101); handle.tap()
  assert.equal(subject.data.analysisSheetOffset, -86, '轻触重新展开至半屏')
  handle.start(400); handle.end(400); handle.tap()
  assert.equal(subject.data.analysisSheetOffset, -300, '轻触支持收起')
  handle.computed('150px')
  handle.start(250); handle.move(230); handle.end(230)
  assert.equal(subject.data.analysisSheetOffset, -170, '打断吸附动画时从当前可见位置接住面板')
  handle.computed(null)

  handle.owner.defer = true
  handle.start(230); handle.move(210); handle.end(210)
  handle.start(210); handle.move(190)
  handle.flush(); handle.sync()
  assert.equal(handle.styles.height, '90px', '上一手势迟到的提交不覆盖当前拖动')
  handle.end(190); handle.flush(); handle.sync()
  handle.owner.defer = false
  assert.equal(subject.data.analysisSheetOffset, -210)
  handle.sync(true)
  assert.equal(handle.styles.height, '90px', '入口重建恢复已保存位置')
  handle.start(190); handle.move(170)
  const staleVersion = subject.data.analysisSheetVersion
  session.showQuestionAtIndex(1)
  subject.applyViewModelResult({ data: session.getViewData() })
  handle.sync()
  handle.end(150)
  subject.onAnalysisHandleEnd({ offset: -20, version: staleVersion })
  assert.equal(subject.data.analysisSheetOpen, false, '换到未答题收回解析')
  assert.equal(subject.data.currentExplanation, '')
  session.selectOption(0)
  subject.applyViewModelResult({ data: session.getViewData() })
  assert.equal(subject.data.hasAnswered, false, '多选输入仍是草稿')
  assert.equal(subject.data.analysisSheetOpen, false)
  session.selectOption(1); session.commitCurrentAnswer(session.state.selectedKeys)
  subject.applyViewModelResult({ data: session.getViewData() })
  assert.equal(subject.data.analysisSheetOpen, true, '多选确认后才展开')
  assert.equal(subject.data.analysisSheetOffset, -86, '新题确认后恢复半屏')
  subject.applyViewModelResult({ data: { isCompleted: true } })
  assert.equal(subject.data.analysisSheetOpen, false)
  for (const height of [382, 481, 658, 746]) {
    const measured = page()
    measured.data.analysisSheetOpen = true
    measured.setData(measured.analysisMeasurement({ top: 88, height }))
    assert.equal(measured.data.analysisSheetHeight + measured.data.analysisSheetOffset, Math.floor(height / 2), '先展开后测量也落在半屏')
    measured.setData(measured.analysisMeasurement({ top: 88, height: height + 100 }))
    assert.equal(measured.data.analysisSheetHeight + measured.data.analysisSheetOffset, Math.floor((height + 100) / 2), '窗口变化后默认位置保持半屏')
    measured.data.analysisSheetOffset += 20
    const visible = measured.data.analysisSheetHeight + measured.data.analysisSheetOffset
    measured.setData(measured.analysisMeasurement({ top: 88, height: height + 120 }))
    assert.equal(measured.data.analysisSheetHeight + measured.data.analysisSheetOffset, visible, '重新测量保留手动展开的位置')
    measured.data.analysisSheetOffset = 0
    measured.setData(measured.analysisMeasurement({ top: 88, height }))
    assert.equal(measured.data.analysisSheetOffset, 0, '完全展开时随窗口更新上限')
    measured.closeAnalysis()
    measured.setData(measured.analysisMeasurement({ top: 88, height: height + 100 }))
    assert.equal(measured.data.analysisSheetOffset, -measured.data.analysisSheetHeight, '收起状态在重新测量后保持')
  }
  for (const mode of ['test', 'view']) {
    const model = new PracticeSession({ quiz, mode })
    model.reset(); model.selectOption(0)
    const other = page()
    other.applyViewModelResult({ data: model.getViewData() })
    other.setAnalysisOpen(true)
    assert.equal(other.data.analysisSheetOpen, false, `${mode} 不使用即时反馈 TopSheet`)
  }
  const objectiveQuiz = { bankId: 'b', questions: [0, 1].map(index => ({ id: 'choice-' + index, type: 'SINGLE_CHOICE', stem: '题干', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKeys: ['A'], explanation: '完整解析' })) }
  for (const feedback of ['IMMEDIATE', 'AFTER_FINISH']) for (const autoOpenAnalysis of [false, true]) for (const autoNextWhenCorrect of [false, true]) for (const correct of [false, true]) {
    const model = new PracticeSession({ quiz: objectiveQuiz, mode: 'practice', feedback, preferences: { autoOpenAnalysis, autoNextWhenCorrect } })
    model.reset()
    const target = page()
    target.applyViewModelResult({ data: model.getViewData() })
    const answer = model.selectOption(correct ? 0 : 1)
    const advancing = feedback === 'IMMEDIATE' && autoNextWhenCorrect && correct
    assert.equal(!!answer.autoAdvance, advancing)
    target.applyViewModelResult(answer)
    assert.equal(target.data.analysisSheetOpen, feedback === 'IMMEDIATE' && autoOpenAnalysis && !advancing, '自动展开与跳题组合按反馈模式生效')
    target.setAnalysisOpen(true)
    assert.equal(target.data.analysisSheetOpen, feedback === 'IMMEDIATE', '确认后仍可手动打开，统一反馈保持隐藏')
    assert.equal(target.data.currentExplanation, feedback === 'IMMEDIATE' ? '完整解析' : '')
    target.applyViewModelResult(model.showQuestionAtIndex(1))
    const last = model.selectOption(0)
    assert.equal(!!last.autoAdvance, false, '末题不自动跳转')
    target.applyViewModelResult(last)
    assert.equal(target.data.analysisSheetOpen, feedback === 'IMMEDIATE' && autoOpenAnalysis)
    const revisit = model.showQuestionAtIndex(0)
    assert.equal(!!revisit.autoAdvance, false, '回看不启动自动跳题')
    target.applyViewModelResult(revisit)
    assert.equal(target.data.analysisSheetOpen, feedback === 'IMMEDIATE' && autoOpenAnalysis)
  }
  const originalSetTimeout = global.setTimeout, originalClearTimeout = global.clearTimeout
  try {
    let timer, navigations = 0
    global.setTimeout = (callback, delay) => { assert.equal(delay, 800); timer = callback; return 1 }
    global.clearTimeout = () => { timer = null }
    const target = page()
    Object.assign(target.data, { shouldRevealAnswer: true, hasAnswered: true, feedback: 'IMMEDIATE' })
    target.clearAutoAdvance = definition.clearAutoAdvance
    target.goNext = () => { navigations++ }
    target.scheduleAutoAdvance(); timer()
    assert.equal(navigations, 1, '等待0.8秒后自动下一题')
    target.scheduleAutoAdvance(); target.setAnalysisOpen(true)
    assert.equal(timer, null, '手动打开解析取消真实计时器')
    target.scheduleAutoAdvance(); target.onAnalysisHandleStart({ version: target.data.analysisSheetVersion })
    assert.equal(timer, null, '拖动把手取消真实计时器')
  } finally { global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout }
  const wxml = fs.readFileSync(require.resolve('../miniprogram/page/practice/index.wxml'), 'utf8')
  assert.match(wxml, /shouldRevealAnswer && hasAnswered && feedback === 'IMMEDIATE' && !isViewMode/, '把手只在即时模式已确认后存在')
  const content = fs.readFileSync(require.resolve('../miniprogram/templates/practice-content.wxml'), 'utf8')
  assert(!content.includes('layout-module-analysis'), '解析不再进入可排序布局')
  const stem = fs.readFileSync(require.resolve('../miniprogram/templates/practice-stem.wxml'), 'utf8')
  assert.match(stem, /currentQuestion.isFillBlank/, '填空详解跟随题干输入区')
  const inline = fs.readFileSync(require.resolve('../miniprogram/templates/practice-inline-analysis.wxml'), 'utf8')
  assert.match(inline, /shouldRevealAnswer && !editLayout && !legacyAnalysisEnabled/, '内联详解沿用模型揭晓条件')
  assert.equal((wxml.match(/class="analysis-handle"/g) || []).length, 1, '收起与展开共用一个把手')
  assert(!wxml.includes('<canvas'), '把手使用随面板合成的普通视图')
  assert.match(wxml, /catchtouchmove="{{analysisDrag.move}}"/)
  const sheetCss = fs.readFileSync(require.resolve('../miniprogram/page/practice/index.wxss'), 'utf8')
  assert.match(sheetCss, /\.analysis-handle\s*\{[^}]*top: 100%[^}]*height: 44px/, '把手固定在面板下沿并保留触摸热区')
  assert(!sheetCss.includes('analysis-arrive'), '入口动画与手势共用位移控制')
  const css = fs.readFileSync(require.resolve('../miniprogram/styles/practice.wxss'), 'utf8')
  assert.match(css, /\.pra-options-content\s*\{[^}]*justify-content:\s*flex-end[^}]*box-sizing:\s*border-box/, '短选项靠底，长选项保留自然内容高度')
} finally { global.Page = oldPage; global.wx = oldWx }
console.log('analysis sheet passed: disclosure, confirmation, drag, cancellation, navigation and modes')
