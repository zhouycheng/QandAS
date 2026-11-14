const assert = require('node:assert/strict')
const api = require('../miniprogram/repositories/api-transport.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const repository = require('../miniprogram/repositories/practice-repository.js')
const revisions = require('../miniprogram/repositories/content-revisions.js')
const vault = require('../miniprogram/repositories/answer-vault.js')
const { QuestionDetailViewModel } = require('../miniprogram/viewmodels/question-detail-viewmodel.js')
const { encrypted } = require('./helpers/encrypted-storage.js')
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const values = new Map()
const storage = encrypted({ get: key => copy(values.get(key)), set: (key, value) => values.set(key, copy(value)), remove: key => values.delete(key), keys: () => [...values.keys()] })
const base = { revisionId: 'revision-1', questionBankId: 'bank', assetIds: [], explanation: '完整解析', options: [], correctAnswer: [] }
const questions = [
  { ...base, id: 'single & 题', type: 'SINGLE_CHOICE', stem: '单选题', options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }], correctAnswer: ['B'] },
  { ...base, id: 'multiple', type: 'MULTIPLE_CHOICE', stem: '多选题', options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }, { key: 'C', content: '丙' }], correctAnswer: ['A', 'C'] },
  { ...base, id: 'judge', type: 'TRUE_FALSE', stem: '判断题', correctValue: false },
  { ...base, id: 'fill', type: 'FILL_BLANK', stem: '填入 {{1}} 和 {{2}}', blankCount: 2, blanks: [{ answers: ['HTTP', '超文本传输协议'] }, { answers: ['GET'] }], blankMatch: { ignoreCase: true, trimWhitespace: true } },
  { ...base, id: 'short', type: 'SHORT_ANSWER', stem: '简答题', contentFormat: 'MARKDOWN', referenceAnswer: '**参考思路**', scoringPoints: ['完整要点'] },
  { ...base, id: 'reading-child', type: 'SINGLE_CHOICE', stem: '阅读小题', options: [{ key: 'A', content: '甲' }], correctAnswer: ['A'], material: { id: 'material', revisionId: 'material-1', passage: '完整阅读材料', assetIds: [], contentFormat: 'MARKDOWN' } }
]
const expectedAnswers = ['B', 'A、C', '错误', '① HTTP / 超文本传输协议\n② GET', '**参考思路**', 'A']
const calls = []
const request = api.request
api.request = async (method, path, query) => {
  calls.push({ method, path, query })
  const question = questions.find(q => path === '/questions/' + encodeURIComponent(q.id))
  assert(question, path)
  const data = copy(question)
  if (!query || !query.includeAnswers) vault.stripQuestion(data)
  return { ok: true, data }
}
async function main() {
  auth.saveAuth(storage, { provider: 'email', userId: 'review-user', token: 'fixture-token' })
  remote.enable(true); remote.bind(storage)
  let page, route
  global.Page = definition => { page = definition }
  global.wx = { navigateTo(options) { route = options.url; options.success({}); options.complete({}) } }
  require('../miniprogram/page/wrong-book/index.js')
  delete global.Page
  page.handleItemTap.call({ data: { type: 'wrong' } }, { currentTarget: { dataset: { id: questions[0].id } } })
  const wrongOptions = Object.fromEntries(new URL('https://fixture.invalid' + route).searchParams)
  assert.equal(wrongOptions.id, questions[0].id)
  assert.equal(wrongOptions.latest, '1', '错题点击进入完整复习详情')
  const detail = new QuestionDetailViewModel({ repository, storage })
  assert.equal(detail.load(wrongOptions).data.ready, false, '冷缓存等待正文')
  const view = (await detail.refreshRemote(wrongOptions)).data
  assert.equal(view.emptyText, '')
  assert.equal(view.stem, '单选题')
  assert.equal(view.correctText, 'B')
  assert.equal(view.explanation, '完整解析')
  assert.equal(view.options[1].isCorrectOption, true)
  assert.equal(view.hasAnswer, false, '单题回看不伪造历史作答')
  assert.deepEqual(calls[0].query, { includeAnswers: true })

  const before = calls.length
  const reopened = new QuestionDetailViewModel({ repository, storage })
  assert.equal(reopened.load(wrongOptions).data.canReveal, false, '新页面等待本次答案读取')
  assert.equal((await reopened.refreshRemote(wrongOptions)).data.correctText, 'B')
  assert.equal(calls.length, before, '五分钟内复用完整加密缓存')
  reopened.release(); remote.releaseQuestion(questions[0].id)
  assert.equal(reopened.load(wrongOptions).data.correctText, '')
  assert.equal((await reopened.refreshRemote(wrongOptions)).data.correctText, 'B', '重新显示恢复答案')

  page.handleItemTap.call({ data: { type: 'favorite' } }, { currentTarget: { dataset: { id: questions[0].id } } })
  assert.equal(new URL('https://fixture.invalid' + route).searchParams.has('latest'), false)
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index], vm = new QuestionDetailViewModel({ repository, storage })
    const hidden = (await vm.refreshRemote({ id: encodeURIComponent(question.id) })).data
    assert.equal(hidden.stem, question.stem)
    assert.equal(hidden.canReveal, false)
    assert.equal(hidden.correctText, '')
    assert.equal(hidden.explanation, '')
    assert(hidden.options.every(option => !option.isCorrectOption))
    if (question.blankCount) assert.equal(hidden.blankInputs.length, question.blankCount, '公开填空保留空位数')
    const shown = (await vm.refreshRemote({ id: encodeURIComponent(question.id), latest: '1' })).data
    assert.equal(shown.canReveal, true)
    assert.equal(shown.correctText, expectedAnswers[index], question.type)
    assert.equal(shown.explanation, question.explanation)
    assert.deepEqual(shown.scoringPoints, question.scoringPoints || [])
    if (question.material) assert.equal(shown.material.passage, '完整阅读材料')
    vm.release(); remote.releaseQuestion(question.id)
  }
  assert(!JSON.stringify([...values]).includes('完整解析'), '普通持久存储不含答案明文')

  const bad = { ...questions[0], id: 'bad', correctAnswer: null }
  questions.push(bad)
  const invalid = await new QuestionDetailViewModel({ repository, storage }).refreshRemote({ id: 'bad', latest: '1' })
  assert.match(invalid.data.emptyText, /答案资料下载不完整/)
  assert.equal(invalid.data.canReveal, false)
  assert.equal(storage.get('qandaContentLatest:review-user:bad'), undefined, '拒绝发布缺失答案的正文')

  let finish
  const getter = storage.getEncrypted
  storage.getEncrypted = key => new Promise(resolve => { finish = () => getter(key).then(resolve) })
  const leaving = new QuestionDetailViewModel({ repository, storage })
  const loading = leaving.refreshRemote(wrongOptions)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  leaving.release(); finish()
  assert.equal(await loading, null, '离开页面后忽略迟到的解密结果')
  storage.getEncrypted = getter

  const switched = new QuestionDetailViewModel({ repository, storage })
  api.request = () => new Promise(resolve => { finish = resolve })
  const pending = switched.refreshRemote({ id: 'during-switch', latest: '1' })
  auth.saveAuth(storage, { provider: 'email', userId: 'other-user', token: 'other-token' })
  remote.bind(storage)
  finish({ ok: true, data: { ...questions[0], id: 'during-switch' } })
  assert.equal((await pending).data.canReveal, false)
  assert.equal(remote.findQuestionEntries(['during-switch']).length, 0, '账号切换拒绝旧请求')
  assert.equal(storage.get('qandaContentLatest:other-user:during-switch'), undefined)
  console.log('错题点击、全部题型、连续回看数据、加密缓存、揭晓时机与迟到响应检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { api.request = request; revisions.clear(); delete global.wx })
