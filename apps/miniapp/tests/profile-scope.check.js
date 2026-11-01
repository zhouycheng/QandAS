const assert = require('node:assert/strict')
const rules = require('../miniprogram/utils/profile-rules.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const api = require('../miniprogram/repositories/api-transport.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const data = new Map()
const storage = { get: key => data.get(key), set: (key, value) => data.set(key, value), remove: key => data.delete(key) }
async function run() {
  assert.equal(rules.academicYear(Date.parse('2026-08-31T15:59:59Z')), 2025)
  assert.equal(rules.academicYear(Date.parse('2026-08-31T16:00:00Z')), 2026)
  assert.equal(rules.successCommand({ token: 't', profile: { profileComplete: false } }).url, '/page/account/index?required=1')
  assert.equal(rules.successCommand({ token: 't', profile: { profileComplete: true } }).type, 'back')
  const identity = { provider: 'email', userId: 'u', token: 't', profile: { collegeId: 'c', majorId: 'm', currentGrade: 2, profileComplete: true } }
  auth.saveAuth(storage, identity)
  remote.enable(true); remote.bind(storage)
  const original = api.request, clock = Date.now
  let resolve
  api.request = () => new Promise(done => { resolve = done })
  try {
    const search = remote.searchQuestions(storage, '旧专业', 1)
    auth.saveAuth(storage, { ...identity, profile: { ...identity.profile, majorId: 'other' } })
    resolve({ ok: true, data: { items: [{ id: 'q-old', type: 'SINGLE_CHOICE', stem: '旧范围题目' }], page: 1, total: 1 } })
    await assert.rejects(search, /范围已变化/)
    assert.equal(remote.getQuestionIndex()['q-old'], undefined)
    Date.now = () => Date.parse('2026-08-31T15:59:59Z')
    const previous = rules.scopeKey(auth.getAuth(storage))
    const crossing = remote.searchQuestions(storage, '跨学年', 1)
    Date.now = () => Date.parse('2026-08-31T16:00:00Z')
    assert.notEqual(rules.scopeKey(auth.getAuth(storage)), previous)
    resolve({ ok: true, data: { items: [], page: 1, total: 0 } })
    await assert.rejects(crossing, /范围已变化/)
    console.log('profile scope: required onboarding, Shanghai academic year and stale search rejection passed')
  } finally { api.request = original; Date.now = clock; remote.enable(false) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
