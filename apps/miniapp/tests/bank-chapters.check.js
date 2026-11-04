const assert = require('node:assert/strict')
const fs = require('node:fs')
const api = require('../miniprogram/repositories/api-transport.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const { BankDetailViewModel } = require('../miniprogram/viewmodels/bank-detail-viewmodel.js')

async function main() {
  const subjects = Array.from({ length: 100 }, (_, index) => ({ id: 's' + index, name: '科目' + index, bankCount: 1, questionCount: 2, banks: [{ id: 'b' + index, name: '题库' + index, questionCount: 2 }] }))
  let detailReads = 0
  const projection = new BankDetailViewModel({ repository: {
    getProgress: () => ({}), getRemoteRecent: () => [],
    getRemoteChapters: () => [{ id: 'chapter', name: '章节', questionCount: 2 }],
    getSubjectDetail: id => { detailReads += 1; return subjects.find(subject => subject.id === id) }
  } })
  projection.railMode = 'recent'
  const projected = projection.buildViewData(subjects, subjects[0])
  assert.equal(detailReads, 1, '投影当前科目时不重建全目录搜索索引')
  assert.equal(projected.subjects.length, 100)
  assert(projected.subjects.every(subject => !subject.active && subject.recentActive))
  assert.deepEqual(projected.chapterGroups.map(group => group.rows.map(row => row.title)), [['章节']])
  const values = {}
  const storage = { get: key => values[key], set: (key, value) => { values[key] = value }, remove: key => delete values[key] }
  auth.saveAuth(storage, { provider: 'email', userId: 'student', token: 'token' })
  let banks = [
    { id: 'a', subjectId: 's', name: '题库甲', activeQuestionCount: 4, contentVersion: 1, progress: { wrongCount: 1, wrongBookCount: 1 } },
    { id: 'b', subjectId: 's', name: '题库乙', activeQuestionCount: 1, contentVersion: 1 }
  ]
  const chapters = {
    a: [{ id: 'a1', name: '第一章', questionCount: 1, progress: { answeredCount: 1, correctCount: 1, wrongCount: 0, wrongBookCount: 0 } }, { id: 'a2', name: '第二章', questionCount: 2, progress: { answeredCount: 1, correctCount: 0, wrongCount: 1, wrongBookCount: 1 } }],
    b: [{ id: 'b1', name: '第一章', questionCount: 1, progress: { answeredCount: 0, correctCount: 0, wrongCount: 0 } }]
  }
  let failBank = '', selectedScope
  api.request = async (method, path, query) => {
    if (path === '/subjects') return { ok: true, data: { items: [{ id: 's', name: '科目', bankCount: banks.length, questionCount: 5 }], total: 1, page: 1, pageSize: 20 } }
    if (path === '/question-banks') return { ok: true, data: { items: banks.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: banks.length, page: query.page, pageSize: query.pageSize } }
    const match = path.match(/^\/question-banks\/([ab])(\/chapters)?$/)
    if (match) return match[2] && failBank === match[1] ? { ok: false, reason: '章节读取失败' } : { ok: true, data: match[2] ? chapters[match[1]] : banks.find(bank => bank.id === match[1]) }
    if (path === '/practice/scope-preview') { selectedScope = query; return { ok: true, data: { selectedCount: 2 } } }
    throw new Error('未预期请求 ' + path)
  }
  remote.enable(true)
  const model = new BankDetailViewModel({ storage })
  const data = (await model.refreshRemote('s')).data
  assert.equal(data.showBankTitles, true)
  assert.deepEqual(data.chapterGroups.map(group => [group.name, group.rows.map(row => row.title)]), [['题库甲', ['第一章', '第二章', '全部题目']], ['题库乙', ['第一章']]])
  assert.equal(new Set(data.rows.map(row => row.id)).size, 4, '跨题库同名章节保持独立行')
  assert.equal(data.rows[0].metaText, '1/1')
  const all = await model.openSubjectConfig('s')
  assert.equal(all.data.configSheetVisible, true)
  assert.deepEqual(all.data.sheetBanks.map(bank => bank.selected), [true, true])
  assert.equal(all.data.sheetAllBanksSelected, true)
  await model.confirmConfig()
  assert.deepEqual(selectedScope.questionBankIds, ['a', 'b'])
  assert.equal(selectedScope.count, 20)
  assert.equal(model.setSheetOnlyWrong(true).data.sheetWrongCount, 1)
  await model.confirmConfig()
  assert.equal(selectedScope.selectionKind, 'WRONG')
  const partial = model.setSheetBank('a').data
  assert.equal(partial.sheetSomeBanksSelected, true)
  assert.equal(partial.sheetOnlyWrong, false, '取消含错题的题库后同步取消空错题筛选')
  const one = await model.confirmConfig()
  assert.deepEqual(selectedScope.questionBankIds, ['b'])
  assert(one.command.payload.url.includes('bankId=b'))
  assert.equal(model.setSheetBank('b').data.sheetStartDisabled, true)
  assert.equal(model.confirmConfig().command.title, '请至少选择一个题库')
  assert.equal(model.setSheetBank('all').data.sheetAllBanksSelected, true)
  assert.equal(model.setSheetBank('all').data.sheetStartDisabled, true)
  model.setSheetBank('all')
  const sheet = await model.openBankConfig('s', 'a', 'a2')
  assert.equal(sheet.data.configSubtitle, '题库甲 · 第二章 · 共 2 题')
  assert.equal(sheet.data.sheetWrongCount, 1)
  assert.equal(sheet.data.sheetChapters, undefined)
  await model.confirmConfig()
  assert.equal(selectedScope.questionBankId, 'a')
  assert.deepEqual(selectedScope.chapterIds, ['a2'])
  assert.equal((await model.openBankConfig('s', 'a', 'b1')).command.type, 'toast', '异库章节不能转成整库练习')
  const search = await model.updateSearch('第一章')
  assert.deepEqual(search.data.searchResults.map(row => row.chapterId), ['a1', 'b1'])
  banks = banks.slice(0, 1)
  const single = (await model.refreshRemote('s', { force: true })).data
  assert.equal(single.showBankTitles, false)
  assert.equal(single.rows[0].title, '第一章')
  assert(single.rows.some(row => row.title === '全部题目'), '未分章题目仍有直接练习入口')
  banks.push({ id: 'b', subjectId: 's', name: '题库乙', activeQuestionCount: 1, contentVersion: 1 })
  failBank = 'b'
  const failed = (await model.refreshRemote('s', { force: true })).data
  assert.equal(failed.catalogError, '章节读取失败')
  assert(failed.rows.some(row => row.chapterId === 'a1'), '局部失败保留其他题库章节')
  failBank = ''
  assert.equal((await model.refreshRemote('s', { force: true })).data.catalogError, '')
  banks = banks.concat(Array.from({ length: 19 }, (_, i) => ({ id: 'extra' + i, subjectId: 's', name: '题库' + i, activeQuestionCount: 1, contentVersion: 1 })))
  await model.refreshRemote('s', { force: true })
  const paged = await model.openSubjectConfig('s')
  assert.equal(paged.data.sheetBanks.length, 21, '跨分页完整读取候选题库')
  assert.equal(paged.data.sheetBanks[20].id, 'extra18')
  const markup = fs.readFileSync(__dirname + '/../miniprogram/page/bank-detail/index.wxml', 'utf8')
  assert(markup.includes('group.name') && markup.includes('group.rows'))
  assert(!markup.includes('config-chapters'))
  console.log('章节列表自检通过：单库平铺、多库分组、章节进度、同名章节、搜索、筛选、范围与失败重试')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
