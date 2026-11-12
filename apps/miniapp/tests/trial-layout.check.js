const assert = require('node:assert/strict')
const trials = require('../miniprogram/repositories/trial-practice.js')
const online = require('../miniprogram/repositories/online-practice.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const http = require('../miniprogram/repositories/http-gateway.js')
const repository = require('../miniprogram/repositories/practice-repository.js')
const { PracticeViewModel } = require('../miniprogram/viewmodels/practice-viewmodel.js')
const { QuestionDetailViewModel } = require('../miniprogram/viewmodels/question-detail-viewmodel.js')
const { PracticeLayoutViewModel } = require('../miniprogram/viewmodels/practice-layout-viewmodel.js')
const { DEFAULT_ORDER, move } = require('../miniprogram/utils/practice-layout.js')
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
function memory() {
  const data = {}
  return require('./helpers/encrypted-storage.js').encrypted({ data, full: false, get(key) { return copy(data[key]) }, set(key, value) { if (this.full) throw Error('存储已满'); data[key] = copy(value) }, remove(key) { delete data[key] }, keys() { return Object.keys(data) } })
}
function snapshot(id, feedback) {
  const types = ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER']
  return { id, questionBankId: 'bank', feedback, configuration: { count: 4 }, createdAt: new Date().toISOString(),
    items: types.map((type, i) => ({ itemId: 'i' + i, position: i, question: { id: 'q' + i, revisionId: 'r' + i, type, stem: type, options: type.endsWith('CHOICE') ? [{ key: 'A', content: '选项甲' }, { key: 'B', content: '选项乙' }] : [], correctAnswer: null, correctValue: null, explanation: null } })),
    offlineGrading: types.map((type, i) => ({ itemId: 'i' + i, correctAnswer: type === 'MULTIPLE_CHOICE' ? ['A', 'B'] : ['A'], correctValue: true, referenceAnswer: type === 'SHORT_ANSWER' ? '参考内容' : '', explanation: '仅确认后展示的解析' })) }
}
async function main() {
  let count = 0, offline = false, lose = false
  const requests = []
  http.request = async (method, path, body, options) => {
    requests.push({ method, path, body, options })
    if (offline || lose) { lose = false; return { ok: false, reason: '请求超时' } }
    if (path === '/question-banks/bank') return { ok: true, data: { id: 'bank', name: '四题试答', activeQuestionCount: 4, contentVersion: 1 } }
    assert.equal(path, '/practice/trial-snapshots', '试答只能请求公开快照')
    assert.equal(body.scope.count, 4)
    return { ok: true, data: snapshot('trial-' + (++count), body.feedback) }
  }
  const storage = memory()
  online.enable(storage); remote.enable()
  await assert.rejects(trials.prepare(storage, { bankId: 'bank', selectionKind: 'WRONG' }), /登录/)
  assert.equal(requests.length, 0, '游客的个人集合范围不能退化为全部题目')
  lose = true
  await assert.rejects(trials.prepare(storage, { bankId: 'bank', mode: 'order' }), /超时/)
  assert.equal(trials.remaining(storage), 2)
  storage.full = true
  await assert.rejects(trials.prepare(storage, { bankId: 'bank', mode: 'order' }), /存储已满/)
  storage.full = false
  assert.equal(trials.remaining(storage), 2, '存储失败不扣额度')
  const before = count
  const [a, b] = await Promise.all([trials.prepare(storage, { bankId: 'bank', mode: 'order' }), trials.prepare(storage, { bankId: 'bank', mode: 'order' })])
  assert.equal(a.id, b.id); assert.equal(count, before + 1, '连续点击只创建一次')
  const vm = new PracticeViewModel({ storage })
  const initial = await vm.load({ sessionId: a.id })
  assert.equal(initial.data.shouldRevealAnswer, false)
  assert(!JSON.stringify(initial.data).includes('仅确认后展示的解析'))
  await vm.selectOption(0)
  assert.equal(vm.session.getViewData().shouldRevealAnswer, true)
  await vm.goNext(); await vm.selectOption(0)
  const beforeRestart = requests.length
  offline = true
  const resumed = new PracticeViewModel({ storage })
  await resumed.load({ sessionId: a.id })
  assert.equal(requests.length, beforeRestart, '杀进程后离线恢复不请求')
  assert.deepEqual(resumed.session.state.selectedKeys, ['A'])
  assert.equal(resumed.session.getViewData().shouldRevealAnswer, false, '多选确认前隐藏答案')
  await resumed.selectOption(1); await resumed.goNext()
  assert.equal(resumed.session.getViewData().shouldRevealAnswer, true)
  await resumed.goNext(); await resumed.selectOption(0); await resumed.goNext()
  resumed.setAnswerText('我的简答'); await resumed.goNext()
  assert.equal(resumed.session.getViewData().currentCorrectAnswerText, '', '主观参考内容交卷后展示')
  await resumed.forceSubmit()
  await resumed.assessResult('q3', 'CORRECT')
  assert.equal(resumed.session.state.score, 100, '主观自评不改变客观得分')
  assert.equal(resumed.session.state.isCompleted, true)
  assert.equal(requests.length, beforeRestart, '离线试答交卷只落盘')
  assert.deepEqual(storage.keys().filter(key => !key.startsWith('qandaAnswer:v1:')), [trials.KEY], '试答不写账号、错题、收藏或正式同步记录')
  const detailVm = new QuestionDetailViewModel({ storage })
  const detail = await detailVm.refreshRemote({ sessionId: a.id, id: 'q3' })
  assert.equal(detail.data.correctText, '参考内容')
  assert.equal(trials.remaining(storage), 1)
  offline = false
  const second = new PracticeViewModel({ storage })
  await second.load({ bankId: 'bank', mode: 'test' })
  await second.selectOption(0); await second.goNext()
  assert.equal(second.session.getViewData().currentCorrectAnswerText, '', '统一反馈在交卷前隐藏')
  assert.equal(trials.remaining(storage), 0)
  const third = await new PracticeViewModel({ storage }).load({ bankId: 'bank', mode: 'view' })
  assert.equal(third.command.type, 'trialLogin', '普通练习、模拟考试和背题共用额度')
  storage.set('qandaAuth', { userId: 'another', provider: 'email', token: 'example' })
  assert.equal(trials.remaining(storage), 0, '账号切换保留额度')
  const review = await new PracticeViewModel({ storage }).load({ sessionId: a.id })
  assert.equal(review.data.isCompleted, true, '登录后回看试答仍走本机')
  assert(requests.every(request => request.options.token === ''))

  const local = memory()
  const editor = new PracticeLayoutViewModel({ storage: local })
  const displayed = editor.load().data
  assert.equal(displayed.shouldRevealAnswer, true)
  assert.equal(displayed.currentQuestion.options.length, 3)
  assert.equal(displayed.layoutDirty, false, '初始布局禁用保存')
  assert.deepEqual(editor.save(), {}, '没有修改时不写入也不提示保存')
  const moved = move(DEFAULT_ORDER, 'tools', 0)
  assert.equal(editor.drop('tools', 0).data.layoutDirty, true, '调整顺序后启用保存')
  assert.equal(editor.drop('tools', 3).data.layoutDirty, false, '拖回原顺序后禁用保存')
  editor.drop('tools', 0)
  assert.deepEqual(repository.getPreferences(local).moduleOrder, DEFAULT_ORDER, '拖拽只更新通用布局草稿')
  const saved = editor.save()
  assert.equal(saved.command.title, '布局已保存')
  assert.equal(saved.data.layoutDirty, false, '保存成功后重新禁用')
  assert.deepEqual(repository.getPreferences(local).moduleOrder, moved)
  editor.drop('stem', 0)
  const draft = editor.order.slice()
  local.full = true
  assert.match(editor.save().command.title, /保存失败/)
  assert.deepEqual(editor.order, draft, '保存失败保留草稿供重试')
  assert.equal(editor.getLayoutData().layoutDirty, true, '保存失败可以重试')
  assert.deepEqual(repository.getPreferences(local).moduleOrder, moved, '保存失败保留已存布局')
  local.full = false
  repository.updatePreferenceText(local, 'examName', '期末考试')
  editor.reset()
  assert.deepEqual(repository.getPreferences(local).moduleOrder, moved, '恢复默认点击保存后生效')
  editor.save()
  assert.deepEqual(repository.getPreferences(local).moduleOrder, DEFAULT_ORDER)
  assert.equal(repository.getPreferences(local).examName, '期末考试')
  editor.drop('tools', 0)
  editor.save()
  repository.resetPreferences(local)
  assert.deepEqual(repository.getPreferences(local).moduleOrder, moved, '答题偏好重置保留布局')
  assert.equal(repository.getPreferences(local).examName, '期末考试')
  const reload = new PracticeLayoutViewModel({ storage: local }).load().data
  assert.equal(reload.layoutRanks.tools, 0)
  editor.reset(); editor.drop('info', 3)
  assert.equal(editor.order.at(-1), 'info', '通用模板支持将任意模块拖到末尾')
  const scriptVm = require('node:vm')
  const fs = require('node:fs')
  const context = { module: { exports: {} } }
  scriptVm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/utils/layout-drag.wxs'), 'utf8'), context)
  const drag = context.module.exports, state = {}, calls = [], styles = [], selectedModules = []
  const owner = { getState: () => state, selectComponent: selector => { selectedModules.push(selector); return { setStyle: style => styles.push(style) } }, callMethod: (name, data) => calls.push({ name, data }) }
  assert.equal(drag.move({ touches: [{ clientY: 140 }] }, owner), undefined, '普通滑动不拦截翻页或滚动')
  drag.start({ currentTarget: { dataset: { module: 'stem' } }, touches: [{ clientY: 100 }] }, owner)
  drag.move({ touches: [{ clientY: 140 }], timeStamp: 100 }, owner)
  assert.equal(styles.at(-1).transform, 'translateY(40px)')
  assert.equal(selectedModules.at(-1), '#layout-module-stem', '直接移动通用模板中的模块')
  drag.scroll(20, 0, owner)
  assert.equal(styles.at(-1).transform, 'translateY(60px)', '边缘自动滚动补偿跟手位移')
  drag.cancel({}, owner)
  assert.equal(styles.at(-1).transform, '')
  assert.equal(calls.at(-1).name, 'handleDragCancel', '取消手势只复位')
  assert(!calls.some(call => call.name === 'handleDragEnd'))
  drag.start({ currentTarget: { dataset: { module: 'info' } }, touches: [{ clientY: 200 }] }, owner)
  drag.move({ touches: [{ clientY: 300 }], timeStamp: 200 }, owner)
  drag.end({ changedTouches: [] }, owner)
  assert.equal(calls.at(-1).name, 'handleDragEnd')
  assert.equal(calls.at(-1).data.y, 300, '结束事件没有坐标时使用最后拖动位置')
  assert.equal(state.id, '', '松手后清空拖动状态')
  calls.length = 0
  drag.start({ currentTarget: { dataset: { module: 'response' } }, touches: [{ clientY: 100 }] }, owner)
  drag.move({ touches: [{ clientY: 103 }], timeStamp: 300 }, owner)
  drag.end({ changedTouches: [{ clientY: 103 }] }, owner)
  assert.equal(calls.length, 0, '轻触不触发拖拽或排序')
  let definition, edgeTick
  global.Page = value => { definition = value }
  global.wx = {}
  require('../miniprogram/page/practice-layout/index.js')
  const page = Object.assign({}, definition, { data: {}, viewModel: { order: DEFAULT_ORDER }, setData(patch) { Object.assign(this.data, patch) }, createSelectorQuery() {
    const query = { select() { return query }, selectAll() { return query }, fields() { return query }, boundingClientRect() { return query }, exec: done => {
      const viewportHeight = this.testViewportHeight || 400
      const blocks = DEFAULT_ORDER.map((id, i) => ({ top: 100 + i * 160, bottom: 260 + i * 160, height: ['stem', 'response'].includes(id) ? (this.data.paneHeights && this.data.paneHeights[id] || 0) + 20 : 40, dataset: { module: id } }))
      done([{ top: 100, bottom: 100 + viewportHeight, height: viewportHeight }, blocks, { height: 800, 'padding-top': '2px' }, { top: 200, height: 144 }, blocks.map(() => ({ 'margin-top': '4px', 'margin-bottom': '4px' }))])
    } }; return query
  } })
  const originalInterval = global.setInterval, originalClear = global.clearInterval
  global.setInterval = callback => { edgeTick = callback; return 1 }
  global.clearInterval = () => {}
  try {
    page.measure()
    page.handleDragStart({ id: 'stem', y: 490 })
    edgeTick()
    assert.equal(page.data.scrollTop, 12, '初次触摸尚未滚动时即可触发边缘自动滚动')
    page.handleScroll({ detail: { scrollTop: 360, scrollHeight: 800 } })
    page.handleDragMove({ y: 490 })
    assert.equal(page.drag.index, 3, '跨屏拖动按滚动后的模块位置计算插入目标')
    page.handleDragCancel()
    assert.equal(page.drag, null)
  } finally { global.setInterval = originalInterval; global.clearInterval = originalClear }
  global.wx = { getStorageSync: key => local.get(key), setStorageSync: (key, value) => local.set(key, value), showToast() {} }
  page.onLoad()
  assert.equal(page.data.layoutDirty, false)
  assert.equal(page.data.previewPages, undefined, '所有题型共用一个模板')
  assert.equal(page.data.previewTypes, undefined)
  const savedPreferences = copy(local.get('qandaPreferences'))
  page.measure()
  page.handleDragStart({ id: 'stem', y: 240 })
  assert.equal(page.drag.id, 'stem', '触摸模块即可开始拖拽')
  page.handleDragCancel()
  assert.equal(page.drag, null, '取消后可以再次拖拽')
  assert.deepEqual(local.get('qandaPreferences'), savedPreferences, '取消拖动不更改已保存布局')
  page.handleRatioTouchStart({ touches: [{ clientY: 218 }] })
  assert.equal(page.data.stemPercent, 65, '竖向拖动按实际轨道坐标更新比例')
  assert.equal(page.drag, null, '拖动比例滑杆不触发模块排序')
  page.handleRatioTouchMove({ touches: [{ clientY: 344 }] })
  assert.equal(page.data.stemPercent, 30, '向下拖到底部为最小值')
  page.handleRatioTouchEnd({ changedTouches: [{ clientY: 200 }] })
  assert.equal(page.data.stemPercent, 70, '向上拖到顶部为最大值')
  assert.equal(page.ratioAdjusting, false)
  page.handleRatioStep({ currentTarget: { dataset: { step: -5 } } })
  assert.equal(page.data.stemPercent, 65, '按钮可按步长调节')
  assert.deepEqual(local.get('qandaPreferences'), savedPreferences, '滑杆调节仅更新草稿')
  page.handleRatioTouchStart({ touches: [{ clientY: 218 }] })
  page.onHide()
  assert.equal(page.ratioAdjusting, false, '离开页面结束比例调节')
  assert.equal(page.data.stemPercent, 65, '结束手势后保留调节草稿')
  page.onShow()
  page.handleRatioStep({ currentTarget: { dataset: { step: 5 } } })
  assert.equal(page.data.stemPercent, 70)
  for (const height of [280, 400, 700]) {
    page.testViewportHeight = height
    page.measure()
    const paneHeight = Object.values(page.data.paneHeights).reduce((a, b) => a + b, 0)
    assert.equal(paneHeight + 2 * 20 + 2 * 40 + 4 * 8 + 2, height, '分区填满扣除模块边框、内外边距后的预览空间')
  }
  page.handleResetLayout()
  assert.deepEqual(local.get('qandaPreferences'), savedPreferences)
  page.handleSaveLayout()
  assert.equal(page.data.layoutDirty, false)
  assert.deepEqual(repository.getPreferences(local).moduleOrder, DEFAULT_ORDER, '保存按钮持久化通用布局')
  const quota = storage.get(trials.KEY)
  const invalid = memory()
  invalid.set(trials.KEY, { ...quota, usedCount: null })
  assert.throws(() => trials.remaining(invalid), /无法读取/, '损坏的额度必须明确报错')
  storage.set(trials.KEY, { ...quota, sessions: [] })
  assert.equal(trials.remaining(storage), 0, '清理草稿保留已使用试答次数')
  console.log('trial-layout checks passed: quota, persistence failure, duplicate starts, four question types, offline restore, disclosure, account isolation, layout rollback')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
