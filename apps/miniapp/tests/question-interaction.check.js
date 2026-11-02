const assert = require('node:assert/strict')
const { PracticeSession } = require('../miniprogram/models/practice-session.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const { mapQuestion } = require('../miniprogram/repositories/online-practice.js')
const { gradeBlanks } = require('../miniprogram/utils/fill-blank.js')
const { serializeSession, normalizeSession } = require('../miniprogram/models/practice-session-state.js')
const { contentBlocks } = require('../miniprogram/utils/rich-content.js')
const { swipeDirection } = require('../miniprogram/utils/question-swipe.js')
const { normalizePreferences, buildPreferenceView } = require('../miniprogram/utils/preferences.js')
assert.equal(normalizePreferences(null).showSelfAssessment, true)
assert.equal(buildPreferenceView({ showSelfAssessment: false }).switches.find(item => item.key === 'showSelfAssessment').value, false)

function question(type, id) {
  return mapQuestion({ itemId: id, question: { id, type, stem: type === 'FILL_BLANK' ? '{{1}} / {{2}}' : '题干', blankCount: 2, contentFormat: 'MARKDOWN', options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }, { key: 'C', content: '丙' }] } }, {
    correctAnswer: type === 'MULTIPLE_CHOICE' ? ['A', 'B'] : ['A'], correctValue: true, referenceAnswer: 'reference-secret', scoringPoints: ['point-secret'], explanation: 'explanation-secret', blanks: [{ answers: ['A'] }, { answers: ['B'] }], blankMatch: { ignoreCase: false, trimWhitespace: true }
  })
}
function session(types, options) {
  const model = new PracticeSession({ quiz: { bankId: 'bank', questions: types.map((type, index) => question(type, `q${index}`)) }, mode: 'practice', ...options })
  model.reset()
  return model
}

for (const fixture of require('../../../packages/content-format/fixtures/blank-grading.json')) {
  assert.equal(gradeBlanks({ blanks: [{ answers: fixture.answers }], blankMatch: fixture }, [fixture.value]), fixture.correct, fixture.name)
}
for (const fixture of require('../../../packages/content-format/fixtures/scoring.json')) {
  const model = session(Array(fixture.objective).fill('SINGLE_CHOICE').concat(Array(fixture.subjective).fill('SHORT_ANSWER')), { feedback: 'AFTER_FINISH' })
  for (let i = 0; i < fixture.correct + fixture.wrong; i++) { model.jumpToQuestion(i); model.selectOption(i < fixture.correct ? 0 : 1) }
  for (let i = fixture.objective; i < model.state.total; i++) { model.jumpToQuestion(i); model.setAnswerText('理解') }
  model.jumpToQuestion(0)
  const result = model.forceSubmit()
  assert.equal(result.data.score, fixture.score)
  assert.equal(result.data.objectiveAccuracyText, fixture.accuracy === null ? '—' : `${Math.round(fixture.accuracy * 1000) / 10}%`)
  assert.equal(result.data.wrongQuestionIds.length, fixture.wrong)
  assert.equal(result.data.resultFilterCounts.unscored, fixture.subjective)
  assert(!model.forceSubmit().saveDailyLog, '重复交卷不重复计入统计')
}

for (const feedback of ['IMMEDIATE', 'AFTER_FINISH']) for (const autoNextWhenCorrect of [false, true]) {
  const model = session(['MULTIPLE_CHOICE', 'FILL_BLANK', 'SHORT_ANSWER'], { feedback, preferences: { autoNextWhenCorrect } })
  model.selectOption(1); model.selectOption(0)
  assert.equal(model.state.answers[0].confirmed, false)
  assert.equal(model.state.shouldRevealAnswer, false)
  assert.equal(model.state.primaryActionText, feedback === 'IMMEDIATE' ? '确认' : '下一题')
  assert.equal(model.getOverviewItems(model.state.answers, 0)[0].isDraft, true)
  const next = model.goNext()
  assert.equal(!!next.autoAdvance, feedback === 'IMMEDIATE' && autoNextWhenCorrect)
  if (feedback === 'IMMEDIATE') {
    assert.equal(model.state.currentIndex, 0)
    assert.equal(model.selectOption(2), null, '即时确认后锁定')
    model.goNext()
  }
  model.setBlank(0, 'A'); model.setBlank(1, 'B')
  assert.equal(model.updateTimer(10).data.blankInputs[0].value, 'A', '计时刷新保持当前输入')
  const blank = model.goNext()
  assert.equal(!!blank.autoAdvance, feedback === 'IMMEDIATE' && autoNextWhenCorrect)
  if (feedback === 'IMMEDIATE') model.goNext()
  model.setAnswerText('理解初稿')
  assert.equal(model.state.shouldRevealAnswer, false)
  assert(!JSON.stringify(model.getViewData()).includes('reference-secret'))
  model.setAnswerText('理解定稿')
  assert.equal(model.state.answers[2].text, '理解定稿')
  model.goPrev(); model.jumpToQuestion(0)
  const restored = session(['MULTIPLE_CHOICE', 'FILL_BLANK', 'SHORT_ANSWER'], { feedback })
  restored.restore(normalizeSession(serializeSession(model.getPersistedState())))
  const finished = restored.forceSubmit().data
  assert.equal(finished.score, 100)
  assert.equal(finished.resultItems[2].correctText, 'reference-secret')
  restored.jumpToQuestion(2); restored.assessShortAnswer('WRONG'); restored.finish()
  assert.equal(restored.state.score, 100)
  assert.deepEqual(restored.state.wrongQuestionIds, [])
  assert.equal(restored.state.resultFilterCounts.review, 1)
}
const skippedRating = session(['SHORT_ANSWER'], { preferences: { showSelfAssessment: false } })
skippedRating.setAnswerText('我的理解')
const skipped = skippedRating.forceSubmit().data
assert.equal(skipped.resultItems[0].selfAssessment, '')
assert.equal(skipped.resultFilterCounts.review, 0)
assert.deepEqual(skipped.wrongQuestionIds, [])
assert.equal(skipped.preferences.showSelfAssessment, false)

const partial = session(['FILL_BLANK', 'FILL_BLANK'], { feedback: 'AFTER_FINISH' })
partial.reset(); partial.setBlank(0, 'A')
assert.equal(partial.updateTimer(10).data.blankInputs[0].value, 'A', '首题重置后的填空输入参与草稿投影')
partial.setBlank(0, 'A'); partial.goNext(); partial.setBlank(0, ' ')
assert.equal(partial.submit().data.pendingConfirmationCount, 1)
const partialResult = partial.autoSubmit().data
assert.equal(partialResult.wrongCount, 1)
assert.equal(partialResult.unansweredCount, 1)
const wrong = session(['MULTIPLE_CHOICE', 'SINGLE_CHOICE'], { preferences: { autoNextWhenCorrect: true } })
wrong.selectOption(0)
assert.equal(wrong.goNext().autoAdvance, undefined, '漏选停留')
wrong.goNext(); assert.equal(wrong.selectOption(0).autoAdvance, undefined, '末题不自动前进')
const view = session(['SHORT_ANSWER'], { mode: 'view', preferences: { autoShowExplanation: false } })
assert.equal(view.getViewData().shouldShowExplanation, true)
assert.equal(view.getViewData().currentCorrectAnswerText, 'reference-secret')
assert.equal(view.forceSubmit().saveWrongResults, undefined)
const timed = session(['SINGLE_CHOICE'], { mode: 'practice', feedback: 'AFTER_FINISH', timeLimitSeconds: 17 })
assert.equal(timed.state.isTimed, true); assert.equal(timed.state.timerSeconds, 17)
assert.equal(session(['SINGLE_CHOICE'], { mode: 'test', feedback: 'IMMEDIATE', isTimed: false }).state.isTimed, false)

const vm = new PracticeViewModel({ storage: { get: () => null, set: () => { throw new Error('存储已满') } } })
vm.session = session(['MULTIPLE_CHOICE', 'SHORT_ANSWER'])
vm.persistSession = () => { throw new Error('存储已满') }
vm.session.selectOption(0)
assert.match(vm.goNext().command.title, /存储/)
assert.equal(vm.session.state.currentIndex, 0)
assert.equal(vm.forceSubmit().data.isCompleted, false)
assert.deepEqual(vm.session.state.answers[0].selectedKeys, ['A'])

const wrongBook = require('../miniprogram/utils/wrong-book.js')
const repository = require('../miniprogram/repositories/practice-repository.js')
const { WrongBookViewModel } = require('../miniprogram/viewmodels/wrong-book-viewmodel.js')
const stored = {}
const storage = { get: key => stored[key], set: (key, value) => { stored[key] = value }, keys: () => Object.keys(stored) }
repository.saveWrongResults(storage, [{ id: 'objective', answered: true, correct: false, objective: true }, { id: 'subjective', answered: true, objective: false }])
assert.deepEqual(wrongBook.getSubjectiveIds(repository.getWrongBook(storage)), [], '未自评不进入待复习')
repository.saveSelfAssessment(storage, 'subjective', 'WRONG')
assert.deepEqual(wrongBook.getPendingIds(repository.getWrongBook(storage)), ['objective'])
assert.deepEqual(wrongBook.getSubjectiveIds(repository.getWrongBook(storage)), ['subjective'])
assert.equal(wrongBook.summarizeWrongBook(repository.getWrongBook(storage)).total, 1)
const bookVm = new WrongBookViewModel({ storage, repository: { ...repository, findQuestionEntries: ids => ids.map(id => ({ id, subjectId: 's', bankId: 'b', bankName: '题库', subjectName: '科目', question: { stem: id, typeText: '题目' } })) } })
assert.deepEqual(bookVm.load({ type: 'wrong' }).data.items.map(item => item.id), ['objective'])
const review = bookVm.refresh({ activeChip: 'subjective' }).data
assert.deepEqual(review.items.map(item => item.id), ['subjective'])
assert.equal(review.stats.find(item => item.key === 'total').value, '1')
assert.equal(review.stats.find(item => item.key === 'subjective').value, '1')
repository.saveWrongResults(storage, [{ id: 'subjective', answered: true, objective: false }])
assert.deepEqual(wrongBook.getSubjectiveIds(repository.getWrongBook(storage)), ['subjective'], '新一次未自评保留先前明确的自评')
repository.saveSelfAssessment(storage, 'subjective', 'CORRECT')
assert.equal(bookVm.refresh({}).data.items.length, 0)
assert.deepEqual(wrongBook.getMasteredIds(repository.getWrongBook(storage)), [], '主观掌握不计入客观攻克数量')

const ast = contentBlocks('> 引用\n>\n> ```html\n> <script>alert(1)</script>\n> ```\n\n| 列 |\n| --- |\n| 表 |\n\n[站点](https://example.test) [危险](javascript:alert(1))', 'MARKDOWN')
const paragraphs = contentBlocks('第一段\n\n第二段\n\n第三段', 'MARKDOWN').blocks
assert.match(paragraphs[0].nodes[0].attrs.style, /margin-top:0;/)
assert.equal(paragraphs[1].nodes[0].attrs.style, 'white-space:pre-wrap;margin:8px 0;')
assert.match(paragraphs[2].nodes[0].attrs.style, /margin-bottom:0;/)
assert.equal(ast.blocks.filter(block => block.tag === 'pre').length, 1)
assert.equal(ast.blocks.find(block => block.tag === 'pre').raw, '<script>alert(1)</script>\n')
assert.equal(ast.blocks.filter(block => block.tag === 'table').length, 1)
assert.deepEqual(ast.links, ['https://example.test'])
assert(!JSON.stringify(ast).includes('"name":"script"'))
const paper = contentBlocks('输出为 **{{1}}**。\n\n```javascript\nconsole.log(1 + 2)\n```', 'MARKDOWN', '', [{ value: '3' }])
assert.deepEqual(paper.blocks[0].parts.filter(part => part.blankIndex !== undefined).map(({ blankIndex, value }) => ({ blankIndex, value })), [{ blankIndex: 0, value: '3' }])
assert.equal(paper.blocks[1].raw, 'console.log(1 + 2)\n')
assert.equal(paper.blocks[1].parts, null)
assert.equal(paper.blocks[0].parts[0].nodes[0].text, '输出为 ')
const tablePaper = contentBlocks('| 项目 | 结果 |\n| --- | --- |\n| 输出 | {{1}} |', 'MARKDOWN', '', [{ value: '3' }])
assert.equal(tablePaper.blocks[0].rows[1].cells[1].parts[0].blankIndex, 0)
assert.equal(tablePaper.blocks[0].rows[1].cells[1].parts[0].value, '3')
let richDefinition
global.Component = definition => { richDefinition = definition }
require('../miniprogram/components/rich-content/index.js')
let richProjection
richDefinition.observers['text, format, codeLanguage, blanks'].call({ setData: data => { richProjection = data }, triggerEvent() {} }, null, null, '', null)
assert.equal(richProjection.blocks[0].nodes[0].children[0].text, '', '异步内容空值保持空文本')
richDefinition.observers['text, format, codeLanguage, blanks'].call({ setData: data => { richProjection = data }, triggerEvent() {} }, '{{1}}', 'PLAIN_TEXT', '', null)
assert.equal(richProjection.blocks[0].parts, null, '只读空位标记不会生成输入框')
delete global.Component
assert.equal(swipeDirection({ x: 100, y: 100, at: 0 }, { x: 40, y: 130, at: 150 }), 1)
assert.equal(swipeDirection({ x: 100, y: 100, at: 0 }, { x: 160, y: 100, at: 150 }), -1)
assert.equal(swipeDirection({ x: 100, y: 100, at: 0 }, { x: 40, y: 150, at: 150 }), 0)
assert.equal(swipeDirection({ x: 100, y: 100, at: 0 }, { x: 40, y: 100, at: 400 }), 0)

let page
global.Page = definition => { page = definition }
require('../miniprogram/page/practice/index.js')
page.data = { feedback: 'IMMEDIATE' }
assert.equal(page.canSwipe(), false)
page.data.feedback = 'AFTER_FINISH'; assert.equal(page.canSwipe(), true)
page.onQuestionTouchStart({ touches: [{ clientX: 200, clientY: 100 }], target: { dataset: { noSwipe: true } } })
assert.equal(page.swipeStart, null, '输入区保留原生聚焦行为且不开始滑题')
for (const key of ['answerFocused', 'keyboardVisible', 'textSelectionActive']) { page[key] = true; assert.equal(page.canSwipe(), false); page[key] = false }
for (const key of ['isCompleted', 'editingLocked', 'waitingForSync', 'showSubmitModal', 'showQuestionOverview', 'editLayout', 'submitting']) { page.data[key] = true; assert.equal(page.canSwipe(), false); page.data[key] = false }
const realTimeout = global.setTimeout, realClear = global.clearTimeout
let timer, advances = 0
global.setTimeout = action => { timer = action; return 1 }; global.clearTimeout = () => { timer = null }
page.data.sessionId = 's'; page.data.currentIndex = 0; page.goNext = () => advances++
page.scheduleAutoAdvance(); const stale = timer; page.clearAutoAdvance(); page.data.currentIndex = 1; stale()
assert.equal(advances, 0)
page.scheduleAutoAdvance(); page.pageVisible = false; timer(); assert.equal(advances, 0)
page.pageVisible = true; page.scheduleAutoAdvance(); timer(); assert.equal(advances, 1)
global.setTimeout = realTimeout; global.clearTimeout = realClear

const hints = []
global.wx = { getWindowInfo: () => ({ windowWidth: 390 }) }
page.selectComponent = id => { assert.equal(id, '#practice-hint'); return { show: text => hints.push(text) } }
page.data.currentIndex = 2; page.data.isLastQuestion = true
page.onQuestionTouchStart({ touches: [{ clientX: 200, clientY: 100 }] })
page.onQuestionTouchEnd({ changedTouches: [{ clientX: 100, clientY: 100 }] })
assert.equal(hints.pop(), '已经是最后一题了')
assert.equal(advances, 1, '末题滑动不能触发交卷')
page.data.currentIndex = 0; page.data.isLastQuestion = false
page.goPrev = () => assert.fail('首题不能后退')
page.onQuestionTouchStart({ touches: [{ clientX: 100, clientY: 100 }] })
page.onQuestionTouchEnd({ changedTouches: [{ clientX: 200, clientY: 100 }] })
assert.equal(hints.pop(), '已经是第一题了')

let component, clock = 0, sequence = 0
const timers = new Map()
require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../miniprogram/components/light-toast/index.js'), 'utf8'), {
  Component: definition => { component = definition },
  setTimeout: (run, delay) => { const id = ++sequence; timers.set(id, { run, at: clock + delay }); return id },
  clearTimeout: id => timers.delete(id)
})
const hint = { ...component.methods, data: { ...component.data }, setData(data) { Object.assign(this.data, data) } }
function tick(ms) {
  clock += ms
  for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.run() }
}
hint.show('已经是最后一题了'); tick(1000); hint.show('已经是第一题了'); tick(600)
assert.equal(hint.data.visible, true, '重复显示重新计时')
assert.equal(hint.data.leaving, false)
tick(1000); assert.equal(hint.data.leaving, true, '先播离场动画')
tick(160); assert.equal(hint.data.visible, false)
hint.show('提示'); component.pageLifetimes.hide.call(hint)
assert.equal(hint.data.visible, false); assert.equal(timers.size, 0)
hint.show('提示'); component.lifetimes.detached.call(hint)
assert.equal(timers.size, 0, '卸载清理定时器')
console.log('question interaction: feedback, drafts, scoring, disclosure, safe content and gestures passed')
