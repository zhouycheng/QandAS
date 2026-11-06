const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const a = { revisionId: 'a', passage: '原文' }, b = { revisionId: 'b', passage: '另一篇' }
const question = (id, material, extra = {}) => ({ id, material, type: 'SINGLE_CHOICE', typeText: '单选', stem: '题干', options: [{ key: 'A', label: 'A', text: '选项' }], answerKeys: ['A'], ...extra })
const quiz = { bankId: 'bank', questions: [question('1', a), question('2', a, { isMultiple: true }), question('3', b), question('4', a), question('5', null)] }
const session = new PracticeSession({ quiz, mode: 'test' })
session.reset()
assert.equal(session.getViewData().readingGroupUnansweredCount, 3)
session.selectOption(0)
assert.equal(session.getViewData().readingGroupUnansweredCount, 2)
assert.equal(session.getViewData().readingGroupDraftCount, 1)
session.showQuestionAtIndex(1); session.selectOption(0); session.commitCurrentAnswer(['A'])
assert.equal(session.getViewData().readingGroupDraftCount, 1)
session.showQuestionAtIndex(2)
assert.equal(session.getViewData().readingGroupTotal, 1, '不同材料修订独立统计')
session.showQuestionAtIndex(3)
assert.equal(session.getViewData().readingGroupNumber, 3, '非连续的小题仍按材料分组')
assert.equal(session.getViewData().readingGroupUnansweredCount, 1)
for (const extra of [{ isShortAnswer: true }, { isFillBlank: true, blanks: [{ answers: ['答案'] }], blankCount: 1 }]) {
  const model = new PracticeSession({ quiz: { bankId: 'b', questions: [question('q', a, extra)] }, mode: 'test' })
  model.reset()
  if (extra.isShortAnswer) model.setAnswerText('答案')
  else model.setBlank(0, '答案')
  assert.equal(model.getViewData().readingGroupUnansweredCount, 0)
  assert.equal(model.getViewData().readingGroupDraftCount, 1)
}

let definition
const oldPage = global.Page, oldWx = global.wx
global.Page = value => { definition = value }
global.wx = { getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }) }
require('../miniprogram/page/practice/index.js')
function page() {
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)), pageVisible: true, hints: [],
    setData(patch, done) {
      for (const [key, value] of Object.entries(patch)) {
        if (key.startsWith('paneScroll.')) this.data.paneScroll[key.split('.')[1]] = value
        else this.data[key] = value
      }
      if (done) done()
    },
    scheduleMeasure() {}, observeSaveStatus() {}, applyViewModelEffects() {}, clearAutoAdvance() {},
    showHint(message) { this.hints.push(message) }, viewModel: {}
  })
}
const context = { module: { exports: {} } }
vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/utils/reading-drag.wxs'), 'utf8'), context)
const drag = context.module.exports
function gestures(subject) {
  const state = {}, calls = [], pending = []
  const styles = {}, material = {}, body = {}
  let old, computed, time = 0
  const owner = {
    getState: () => state,
    selectComponent(selector) {
      const target = selector === '.reading-panel' ? styles : selector === '.reading-material' ? material : body
      return { setStyle: value => Object.assign(target, value), getComputedStyle: () => ({ transform: computed || styles.transform }) }
    },
    callMethod(name, value) { calls.push(name); if (owner.defer) pending.push(() => subject[name](value)); else subject[name](value) }
  }
  const api = {
    owner, styles, material, body, calls,
    computed(value) { computed = value },
    flush() { while (pending.length) pending.shift()() },
    sync() {
      const value = { version: subject.data.readingVersion, geometry: subject.data.readingGeometry, stop: subject.data.readingStop, keyboard: !!subject.data.keyboardVisible, enabled: !subject.data.keyboardVisible && !subject.data.readingSuspended }
      drag.sync(value, old, owner); old = value
    },
    start(y) { drag.start({ touches: [{ clientY: y }], timeStamp: time += 200 }, owner) },
    move(y, dt = 200) { drag.move({ touches: [{ clientY: y }], timeStamp: time += dt }, owner) },
    end(y, dt = 20) { drag.end({ changedTouches: y === undefined ? [] : [{ clientY: y }], timeStamp: time += dt }, owner); api.sync() },
    tap() { drag.tap({}, owner); api.sync() },
    cancel() { drag.cancel({}, owner); api.sync() }
  }
  api.sync()
  return api
}
try {
  const subject = page()
  subject.data.readingLayout = true
  subject.data.readingStop = 0
  subject.data.readingGeometry = { height: 600, handle: 56, heading: 44 }
  const handle = gestures(subject)
  assert.equal(handle.material.height, '544px')
  handle.start(500); handle.end(500); handle.tap()
  assert.equal(subject.data.readingStop, 1)
  assert.equal(handle.body.height, '200px')
  assert.match(handle.styles.transition, /240ms/)
  handle.start(400)
  const calls = handle.calls.length
  handle.move(300)
  assert.equal(handle.styles.transform, 'translate3d(0,200px,0)')
  assert.equal(handle.styles.transition, 'none')
  assert.equal(handle.calls.length, calls, '移动帧只更新视图层')
  assert.equal(subject.canSwipe(), false, '面板拖动期间不能横向切题')
  handle.move(200); handle.end(200)
  assert.equal(subject.data.readingStop, 2)
  handle.tap(); assert.equal(subject.data.readingStop, 2, '拖动后的 tap 不重复切换')
  handle.start(200); handle.move(220, 20); handle.end(220)
  assert.equal(subject.data.readingStop, 1, '快速下滑切换相邻一档')
  handle.start(400); handle.move(300, 20); handle.move(330, 20); handle.end(330)
  assert.equal(subject.data.readingStop, 0, '快速反向拖动采用最后方向')
  handle.start(500); handle.move(100); handle.cancel()
  assert.equal(subject.data.readingStop, 0)
  handle.start(500); handle.move(200)
  drag.move({ touches: [{ clientY: 100 }, { clientY: 200 }] }, handle.owner)
  assert.equal(subject.data.readingStop, 0, '多指中断恢复原档位')
  subject.setReadingStop(2); handle.sync()
  handle.computed('matrix(1, 0, 0, 1, 0, 200)')
  handle.start(300); handle.move(320)
  assert.equal(handle.styles.transform, 'translate3d(0,220px,0)', '打断动画从当前可见位置接住')
  handle.end(320); handle.computed(null)
  handle.owner.defer = true
  handle.start(300); handle.move(200); handle.end(200)
  handle.start(200); handle.move(100)
  const duringDrag = handle.styles.transform
  handle.flush(); handle.sync()
  assert.equal(handle.styles.transform, duringDrag, '上一手势迟到回调不打断新手势')
  handle.end(100); handle.flush(); handle.sync(); handle.owner.defer = false
  const stale = subject.data.readingVersion
  subject.cancelReadingDrag(); handle.sync()
  subject.onReadingHandleEnd({ stop: 0, version: stale })
  assert.notEqual(subject.data.readingStop, 0, '旧版本手势不能覆盖新状态')
  const stop = subject.data.readingStop
  subject.data.keyboardVisible = true; handle.sync()
  assert.equal(handle.material.height, '0px')
  subject.data.keyboardVisible = false; handle.sync()
  assert.equal(subject.data.readingStop, stop, '键盘收起后恢复原档位')
  for (const height of [24, 160, 300, 600, 900]) {
    subject.data.readingGeometry = { height, handle: 56, heading: 44 }; handle.sync()
    assert(parseFloat(handle.material.height) >= 0)
    assert(parseFloat(handle.body.height) >= 0)
  }

  const measured = page()
  measured.data.readingLayout = true
  measured.data.currentQuestion = question('q', a)
  measured.data.preferences.practiceStemPercent = 70
  measured.data.layoutRanks = { tools: 0, response: 1, stem: 2, info: 3 }
  measured.createSelectorQuery = () => {
    const query = { select() { return query }, boundingClientRect() { return query }, exec(done) {
      done([{ height: 600 }, { height: 56 }, { height: 44 }, { height: 700, top: 100 }, { top: 200 }, { top: 212 }, { top: 400 }])
    } }
    return query
  }
  measured.measurePanes()
  assert.deepEqual(measured.data.readingGeometry, { height: 600, handle: 56, heading: 44 })
  assert.deepEqual(measured.data.paneHeights, { material: 0, stem: 140, response: 220 }, '阅读测量不使用普通题的自定义比例')
  measured.keyboardVisible = true
  measured.answerFocused = true
  measured.focusedBlank = { top: 250, height: 30 }
  measured.data.readingGeometry = { height: 200, handle: 0, heading: 0 }
  measured.revealFocusedBlank()
  assert.equal(measured.data.readingQuestionScrollTop, 104, '键盘出现后在连续正文中显示当前填空')

  const reading = page()
  const model = new PracticeViewModel({ storage: { get() {}, set() {} } })
  model.session = new PracticeSession({ quiz, mode: 'test' }); model.session.reset()
  model.persistSession = () => {}
  reading.viewModel = model
  reading.applyViewModelResult({ data: model.session.getViewData() })
  assert.equal(reading.data.readingStop, 1, '首次进入材料默认半屏')
  reading.setReadingStop(0)
  reading.goNext()
  assert.equal(reading.data.currentIndex, 1)
  assert.deepEqual(reading.hints, ['本篇还有 3 道小题未答'])
  reading.setReadingStop(2)
  reading.panePositions = { material: 180 }
  reading.goNext()
  assert.equal(reading.data.readingStop, 1, '新材料默认半屏')
  assert.equal(reading.hints.length, 1, '展开时不提醒')
  reading.setReadingStop(0)
  reading.goNext()
  assert.equal(reading.hints.at(-1), '上一篇还有 1 道小题未答')
  assert.equal(reading.data.readingStop, 2, '跨篇返回恢复档位')
  assert.equal(reading.data.paneScroll.material, 180)
  assert(reading.data.readingQuestionScrollTop < 1, '小题正文回到顶部')
  reading.setReadingStop(0)
  const before = reading.hints.length
  reading.goNext(null, true)
  assert.equal(reading.hints.length, before, '自动跳题不提醒')
  model.session.showQuestionAtIndex(0)
  reading.applyViewModelResult({ data: model.session.getViewData() })
  model.persistSession = () => { throw new Error('保存失败') }
  reading.goNext()
  assert.equal(reading.data.currentIndex, 0)
  assert.equal(reading.hints.length, before, '保存失败不提醒')
  model.persistSession = () => {}
  model.session = new PracticeSession({ quiz, mode: 'order' })
  model.session.reset(); model.session.showQuestionAtIndex(1); model.session.selectOption(0)
  reading.applyViewModelResult({ data: model.session.getViewData() })
  reading.goNext()
  assert.equal(reading.data.currentIndex, 1, '确认草稿而未切题')
  assert.equal(reading.hints.length, before)
  model.session.showQuestionAtIndex(4)
  reading.applyViewModelResult({ data: model.session.getViewData() })
  reading.goNext()
  assert.equal(reading.data.showSubmitModal, true)
  assert.equal(reading.hints.length, before)

  const template = fs.readFileSync(require.resolve('../miniprogram/templates/practice-reading.wxml'), 'utf8')
  assert(!/layoutRanks|practiceStemPercent|practice-content\.wxml/.test(template), '阅读结构独立于自定义分区与排序')
  assert.match(template, /practice-stem\.wxml/)
  assert.match(template, /practice-response\.wxml/)
} finally { global.Page = oldPage; global.wx = oldWx }
console.log('reading panel passed: group counts, drag, interruption, keyboard, navigation and reminders')
