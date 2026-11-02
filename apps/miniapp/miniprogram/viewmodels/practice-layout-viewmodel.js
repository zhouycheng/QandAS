const { PracticeSession } = require('../models/practice-session.js')
const preferences = require('../repositories/preference-repository.js')
const layout = require('../utils/practice-layout.js')
const { mapQuestion } = require('../repositories/online-practice.js')
const PREVIEW_TYPES = ['单选题', '多选题', '判断题', '填空题', '简答题', '阅读小题', '代码输出', '代码理解']
const SAMPLE = { id: 'layout-example', type: 'SINGLE_CHOICE', typeText: '单选题', stem: '学习新知识后，以下哪种复习方式更有助于形成长期记忆？', options: [{ key: 'A', label: 'A', text: '把所有复习集中在考试前一天' }, { key: 'B', label: 'B', text: '间隔一段时间回顾，并主动回忆关键内容' }, { key: 'C', label: 'C', text: '只反复阅读熟悉的段落' }], answerKeys: ['B'], explanation: '间隔复习与主动回忆可以帮助巩固记忆。尝试在当天、几天后和一周后重新回顾知识，再通过练习检查掌握情况。' }
class PracticeLayoutViewModel {
  constructor(options) { this.storage = options.storage; this.previewIndex = 0 }
  static getInitialData() { return Object.assign(require('../models/practice-session.js').getInitialPracticeViewData(), { editLayout: true, moduleLabels: layout.LABELS, dragId: '', dragTarget: '', dragScroll: 0, dragReset: 0, scrollTop: 0, explanationOpen: true }) }
  load() {
    const prefs = preferences.getPreferences(this.storage)
    this.order = prefs.moduleOrder
    const index = this.previewIndex
    const stems = [SAMPLE.stem, '哪些方法有助于形成长期记忆？', '间隔复习与主动回忆有助于形成长期记忆。', '间隔复习有助于形成 {{1}} 记忆。', '请简述两种帮助巩固记忆的学习方法。', '间隔复习有助于形成 {{1}} 记忆。']
    const question = index === 0 ? SAMPLE : mapQuestion({ question: { id: 'layout-example', type: ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'FILL_BLANK', 'SHORT_ANSWER', 'FILL_BLANK', 'FILL_BLANK', 'SHORT_ANSWER'][index], stem: index > 5 ? '阅读代码，' + (index === 6 ? '输出为 {{1}}。' : '说明表达式如何计算并输出。') + '\n\n```javascript\nconsole.log(1 + 2);\n```' : stems[index], contentFormat: index > 5 ? 'MARKDOWN' : 'PLAIN_TEXT', presentation: index > 5 ? 'CODE_ANALYSIS' : 'STANDARD', options: [{ key: 'A', content: '分散安排复习时间' }, { key: 'B', content: '主动回忆关键内容' }, { key: 'C', content: '只在考试前集中阅读' }], blankCount: 1,
      material: index === 5 ? { id: 'material-example', passage: '阅读材料：学习后分多次回顾、主动回忆，比一次集中阅读更有助于保持记忆。', assetIds: [] } : null } },
      { correctAnswer: ['A', 'B'], correctValue: true, blanks: [{ answers: [index > 5 ? '3' : '长期'] }], referenceAnswer: index > 5 ? '先计算 `1 + 2` 得到 `3`，再通过 `console.log` 输出结果。' : '间隔复习，主动回忆。', scoringPoints: index > 5 ? ['识别加法表达式的输入与结果。'] : ['分散复习时间', '主动回忆知识'], explanation: index > 5 ? '程序把 `1 + 2` 的结果输出为 `3`。' : SAMPLE.explanation })
    const session = new PracticeSession({ quiz: { subjectId: 'layout-example', bankId: 'layout-example', sharePath: '/page/practice-layout/index', title: '答题布局预览', questions: [question] }, mode: 'order', preferences: Object.assign({}, prefs, { autoShowExplanation: true, autoNextWhenCorrect: false, showOverviewEntry: true }) })
    session.reset()
    if (question.isFillBlank) { session.setBlank(0, index > 5 ? '3' : '长期'); session.commitCurrentAnswer([]) }
    else if (question.isShortAnswer) { session.setAnswerText(index > 5 ? '先做加法，再输出计算结果。' : '间隔复习，主动回忆。'); session.commitCurrentAnswer([]); session.assessShortAnswer('CORRECT') }
    else if (question.isMultiple) session.commitCurrentAnswer(question.answerKeys)
    else session.selectOption(index === 0 ? 1 : 0)
    session.state.isViewMode = true
    session.showQuestionAtIndex(0)
    return { data: Object.assign(PracticeLayoutViewModel.getInitialData(), session.getViewData(), { previewTypes: PREVIEW_TYPES, previewIndex: index, editLayout: true, moduleLabels: layout.LABELS, layoutRanks: layout.ranks(this.order), explanationOpen: true }) }
  }
  preview(index) { this.previewIndex = Number.isInteger(index) && index >= 0 && index < PREVIEW_TYPES.length ? index : 0; return this.load() }
  save(order) {
    const normalized = layout.normalizeOrder(order)
    try {
      preferences.savePreferences(this.storage, Object.assign(preferences.getPreferences(this.storage), { moduleOrder: normalized }))
      this.order = normalized
      return { data: { layoutRanks: layout.ranks(normalized) } }
    } catch (error) { return { data: { layoutRanks: layout.ranks(this.order) }, command: { title: '布局保存失败，已恢复原顺序' } } }
  }
  drop(id, index) {
    const visible = this.order.filter(key => ![3, 5, 6].includes(this.previewIndex) || key !== 'response').filter(key => key !== id)
    const target = visible[index]
    const remaining = this.order.filter(key => key !== id)
    return this.save(layout.move(this.order, id, target ? remaining.indexOf(target) : remaining.length))
  }
  reset() { return this.save(layout.DEFAULT_ORDER) }
}
module.exports = { PracticeLayoutViewModel }
