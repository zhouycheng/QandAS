const assert = require('node:assert/strict')
const http = require('../miniprogram/repositories/http-gateway.js')
const preferences = require('../miniprogram/repositories/preference-repository.js')
const { normalizePreferences } = require('../miniprogram/utils/preferences.js')
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
function device(token) {
  const data = { qandaAuth: { provider: 'email', userId: 'owner', token }, qandaPreferences: { fontSize: 'xxlarge' } }
  return { data, get: key => copy(data[key]), set: (key, value) => { data[key] = copy(value) }, remove: key => delete data[key] }
}
async function main() {
  const first = device('first'), second = device('second'), third = device('third')
  const original = http.request
  let remote = { version: 1, preferences: normalizePreferences(null) }, offline = false, loseResponse = false, gate = null
  const receipts = new Map(), writes = []
  http.configure({ baseUrl: 'https://example.test/api/v1' })
  http.request = async (method, path, body, options) => {
    assert.equal(path, '/me/preferences')
    if (offline) return { ok: false, statusCode: 0, reason: '网络暂不可用' }
    if (gate) await gate
    if (method === 'GET') return { ok: true, data: copy(remote) }
    writes.push(copy({ body, key: options.idempotencyKey }))
    if (receipts.has(options.idempotencyKey)) return { ok: true, data: copy(receipts.get(options.idempotencyKey)) }
    if (body.expectedVersion !== remote.version) return { ok: false, statusCode: 409 }
    remote = { version: remote.version + 1, preferences: copy(body.preferences) }
    receipts.set(options.idempotencyKey, copy(remote))
    if (loseResponse) { loseResponse = false; return { ok: false, statusCode: 0, reason: '请求超时' } }
    return { ok: true, data: copy(remote) }
  }
  try {
    assert.equal(preferences.getPreferences(first).fontSize, 'normal', '旧设备数据直接由当前设置替代')
    await Promise.all([preferences.refreshPreferences(first), preferences.refreshPreferences(second)])
    let value = preferences.getPreferences(first)
    value.fontSize = 'large'; value.layoutMode = 'custom'; value.practiceStemPercent = 60
    value.examCountdowns = [{ id: 'exam-a', examName: '期末考试', examDate: '2026-12-20' }]
    value.practicePresets.push({ ...value.practicePresets[0], id: 'extra', name: '专项练习', count: 'ALL' }); value.defaultPracticePresetId = 'extra'
    preferences.savePreferences(first, value)
    await preferences.refreshPreferences(first); await preferences.refreshPreferences(second)
    assert.deepEqual(preferences.getPreferences(second), value)
    value.examCountdowns = []; value.practicePresets.splice(1); value.defaultPracticePresetId = 'daily'
    preferences.savePreferences(second, value); await preferences.refreshPreferences(second); await preferences.refreshPreferences(first)
    assert.deepEqual(preferences.getPreferences(first), value, '删除及默认项同步')
    offline = true; value.fontSize = 'small'; preferences.savePreferences(first, value); await preferences.refreshPreferences(first)
    assert.equal(preferences.getPreferences(first).fontSize, 'small')
    offline = false; loseResponse = true; await preferences.refreshPreferences(first)
    assert(first.get('qandaPreferences:account:owner').intent)
    await preferences.refreshPreferences(first)
    assert.equal(writes.at(-1).key, writes.at(-2).key, '丢响应重试沿用原请求')
    await preferences.refreshPreferences(second)
    preferences.savePreferences(second, { ...value, fontSize: 'large' }); await preferences.refreshPreferences(second)
    preferences.savePreferences(first, { ...value, fontSize: 'xxlarge' }); await preferences.refreshPreferences(first)
    assert.equal(preferences.syncState(first).preferenceConflict, true)
    assert.equal(preferences.getPreferences(first).fontSize, 'xxlarge')
    await preferences.resolveConflict(first, false)
    assert.equal(preferences.getPreferences(first).fontSize, 'large')
    preferences.savePreferences(first, { ...value, fontSize: 'small' })
    preferences.savePreferences(second, { ...value, fontSize: 'normal' }); await preferences.refreshPreferences(second)
    await preferences.refreshPreferences(first); await preferences.resolveConflict(first, true)
    assert.equal(remote.preferences.fontSize, 'small')
    let release; gate = new Promise(resolve => { release = resolve })
    const pending = preferences.refreshPreferences(third)
    await Promise.resolve(); third.data.qandaAuth = { provider: 'email', userId: 'other', token: 'other' }; release(); await pending; gate = null
    assert.equal(third.get('qandaPreferences:account:owner'), undefined, '迟到响应不写入已退出账号')
    assert.equal(preferences.getPreferences(third).fontSize, 'normal')
    const broken = { get: first.get, set() { throw Error('full') } }
    assert.throws(() => preferences.savePreferences(broken, value), /full/)
    let settingsPage, loads = 0
    const previousPage = global.Page
    global.Page = definition => { settingsPage = definition }
    try { require('../miniprogram/page/settings/index.js') } finally { global.Page = previousPage }
    const page = { fontChanging: true, viewModel: { load() { loads++; return {} } }, applyViewModelResult() {} }
    settingsPage.handlePreferencesUpdated.call(page)
    assert.equal(loads, 0, '云端回读不打断字号拖动预览')
    page.fontChanging = false; settingsPage.handlePreferencesUpdated.call(page)
    assert.equal(loads, 1)
    console.log('账号设置跨设备读写、删除、离线恢复、幂等、冲突选择和账号隔离通过')
  } finally { http.request = original; http.configure({ baseUrl: '' }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
