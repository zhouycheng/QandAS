const assert = require('node:assert/strict')
let definition
 global.Page = value => { definition = value }; global.wx = {}
require('../miniprogram/page/subject-list/index.js')
async function main() {
 let resolve, reject
 const subjects = [{ id: 's', name: '英语', banks: [{ id: 'a', name: '一' }, { id: 'b', name: '二' }] }]
 const page = { recentOwner: 'token', data: { recentLoaded: true, recentSubjects: subjects, recentSelectedSubjectId: 's', recentSelectedBankId: 'b', recentSelectedName: '英语 · 二' }, setData(p) { Object.assign(this.data, p) }, viewModel: { storage: {}, repository: { getAuth: () => ({ token: 'token' }) }, loadRecentChoices: () => new Promise((a,b) => { resolve = a; reject = b }) } }
 const pending = definition.loadRecentChoices.call(page, { force: true })
 assert.equal(page.data.recentSubjects, subjects)
 assert.equal(page.data.recentSelectedName, '英语 · 二')
 resolve({ subjects, hasHistory: true }); await pending
 assert.equal(page.data.recentSelectedBankId, 'b'); assert.deepEqual(page.data.recentPickerValue, [0, 1])
 const failed = definition.loadRecentChoices.call(page, { force: true }); reject(Error('offline')); await failed
 assert.equal(page.data.recentSubjects, subjects); assert.equal(page.data.recentSelectedBankId, 'b')
 const { BankDetailViewModel } = require('../miniprogram/viewmodels/bank-detail-viewmodel.js')
 let token = 'one'
 const vm = new BankDetailViewModel({ repository: { getAuth: () => ({ token }), getRemoteCatalogPage: () => ({ error: '刷新失败' }), getSubjectSummaries: () => [], getSubjectDetail: () => null, getRemoteSubjectPage: () => ({}) } })
 vm.currentSubjectId = 's'; vm.refreshIdentity = 'one'; vm.refreshSnapshot = { subjectId: 's', subject: { id: 's' }, rows: [{ id: 'chapter' }] }
 assert.equal(vm.projectRemote().rows[0].id, 'chapter'); assert.equal(vm.projectRemote().catalogError, '刷新失败')
 vm.beginFilterRefresh(); vm.currentSubjectId = ''; vm.refreshSnapshot = null
 assert.equal(vm.projectRemote().rows[0].id, 'chapter', '筛选清空仓储时保留上一屏')
 assert.equal(vm.projectRemote().catalogSwitching, true)
 token = 'two'; assert.equal(vm.projectRemote().subject, null)
 console.log('刷新保留：首页内容与选择、失败恢复、题库内容及账号切换通过')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
