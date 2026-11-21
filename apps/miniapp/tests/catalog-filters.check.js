const assert = require('node:assert/strict')
const filters = require('../miniprogram/repositories/catalog-filters.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const api = require('../miniprogram/repositories/api-transport.js')
const values = {}
const storage = { get: key => values[key], set: (key, value) => { values[key] = value }, remove: key => delete values[key] }
async function main() {
  assert.deepEqual(filters.read(storage), { collegeId: '', majorId: '', grade: null })
  assert.deepEqual(filters.toggleState(storage), { enabled: false, restoring: false })
  assert.equal(filters.toggle(storage), null, '从未筛选时不能切换')
  filters.save(storage, { collegeId: 'college', grade: 2 })
  filters.save(storage, { majorId: 'major' })
  assert.deepEqual(filters.toggleState(storage), { enabled: true, restoring: false })
  assert.deepEqual(filters.toggle(storage), { collegeId: '', majorId: '', grade: null })
  assert.deepEqual(filters.toggleState(storage), { enabled: true, restoring: true })
  assert.deepEqual(filters.toggle(storage), { collegeId: 'college', majorId: 'major', grade: 2 }, '恢复时保留同一学院的专业与年级')
  assert.deepEqual(filters.toggle(storage), { collegeId: '', majorId: '', grade: null }, '可重复重置')
  assert.deepEqual(filters.toggle(storage), { collegeId: 'college', majorId: 'major', grade: 2 }, '可重复恢复')
  const failing = { get: storage.get, set() { throw new Error('存储失败') } }
  assert.throws(() => filters.toggle(failing), /存储失败/)
  assert.deepEqual(filters.read(storage), { collegeId: 'college', majorId: 'major', grade: 2 }, '保存失败保留原筛选')
  filters.save(storage, { collegeId: '', grade: null })
  assert.equal(filters.toggleState(storage).restoring, true, '手动清空后仍可恢复最近条件')
  assert.deepEqual(filters.toggle(storage), { collegeId: 'college', majorId: 'major', grade: 2 })
  const invalidValues = {}
  const invalidStorage = { get: key => invalidValues[key], set: (key, value) => { invalidValues[key] = value } }
  filters.save(invalidStorage, { collegeId: 'deleted' })
  filters.save(invalidStorage, { collegeId: '' }, { clearPrevious: true })
  assert.deepEqual(filters.toggleState(invalidStorage), { enabled: false, restoring: false }, '失效分类不会被反复恢复')
  auth.saveAuth(storage, { provider: 'email', userId: 'a', token: 'a-token' })
  auth.saveAuth(storage, { provider: 'email', userId: 'b', token: 'b-token' })
  assert.equal(filters.read(storage).majorId, 'major', '筛选独立于账号')
  filters.save(storage, { collegeId: 'other' })
  assert.equal(filters.read(storage).majorId, '')
  api.getAll = async path => ({ ok: true, data: path === '/colleges' ? [{ id: 'college', name: '学院' }] : [] })
  const invalid = await filters.options(storage)
  assert.equal(invalid.invalid, true)
  assert.equal(filters.read(storage).collegeId, 'other', '读取选项不覆盖并发选择，由页面核验请求后保存')
  remote.setCatalogFilters(storage, invalid.value)
  assert.equal(filters.read(storage).collegeId, '')
  remote.enable(true)
  let resolve
  api.request = () => new Promise(done => { resolve = done })
  const pending = remote.searchQuestions(storage, '旧筛选', 1)
  remote.setCatalogFilters(storage, { grade: 3 })
  resolve({ ok: true, data: { items: [], total: 0, page: 1 } })
  await assert.rejects(pending, /筛选已变化/)
  const requests = []
  let late
  api.request = async (_, path, query) => {
    requests.push({ path, ...query })
    if (path === '/subjects' && query.grade === 1) return new Promise(done => { late = done })
    if (path === '/subjects') return { ok: true, data: { items: [{ id: 'new', name: '新科目' }], total: 30 } }
    if (path === '/subjects/old') return query.grade === 2 ? { ok: false, statusCode: 404 } : { ok: true, data: { id: 'old', name: '旧科目' } }
    return { ok: true, data: { items: [], total: 0 } }
  }
  remote.setCatalogFilters(storage, { grade: 1 })
  const first = remote.refreshCatalog(storage, { subjectId: 'old', subjectPage: 2 })
  await Promise.resolve()
  remote.setCatalogFilters(storage, { grade: 2 })
  await remote.refreshCatalog(storage, { subjectId: 'old', page: 2, force: true })
  late({ ok: true, data: { items: [{ id: 'old', name: '旧科目' }], total: 1 } })
  await first
  assert.deepEqual(remote.getCatalogSubjects().map(row => row.id), ['new'])
  assert.deepEqual(requests.filter(row => row.path === '/question-banks').map(row => [row.grade, row.subjectId, row.page]), [[2,'new',1],[2,'new',2]])
  assert.equal(requests.find(row => row.path === '/subjects/old').grade, 2)
  const { BankDetailViewModel } = require('../miniprogram/viewmodels/bank-detail-viewmodel.js')
  const vm = new BankDetailViewModel({ storage })
  let phase = 'empty'
  api.request = async (_, path, query) => {
    assert.equal(query.grade, 2)
    if (phase === 'error') return { ok: false, statusCode: 503, reason: '目录暂不可用' }
    const items = phase === 'ready' && path === '/subjects' ? [{ id: 'back', name: '恢复的科目' }] : []
    return { ok: true, data: { items, total: items.length } }
  }
  assert.equal((await vm.refreshRemote('', { force: true })).data.subject, null)
  phase = 'error'
  assert.equal((await vm.refreshRemote('', { force: true })).data.catalogError, '目录暂不可用')
  phase = 'ready'
  const restored = (await vm.refreshRemote('', { force: true })).data
  assert.equal(restored.subjectId, 'back')
  assert.equal(restored.catalogError, '')
  remote.enable(false)
  console.log('分类筛选：本机持久化、切换账号保留、失效清理、迟到响应通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
