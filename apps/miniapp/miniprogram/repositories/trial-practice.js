const vault = require('./answer-vault.js')
const { timeLimitSeconds, feedbackForMode } = require('../utils/practice-presets.js')
const http = require('./http-gateway.js')
const projection = require('../models/practice-snapshot.js')
const { getPreferences } = require('./preference-repository.js')
const { normalizePracticeOptions } = require('../utils/preferences.js')
const KEY = 'qandaTrialPractice'
const LIMIT = 2
let creating = null

function read(storage) {
  const value = storage.get(KEY)
  if (!value) return { version: 1, usedCount: 0, sessions: [] }
  if (value.version !== 1 || !Array.isArray(value.sessions)) throw new Error('试答记录无法读取，请联系支持')
  const usedCount = value.usedCount
  if (!Number.isInteger(usedCount) || usedCount < 0 || usedCount > LIMIT) throw new Error('试答记录无法读取，请联系支持')
  const record = JSON.parse(JSON.stringify({ ...value, usedCount }))
  record.sessions.forEach(vault.restore)
  return record
}
function put(storage, record) {
  storage.set(KEY, { ...record, sessions: record.sessions.map(item => vault.strip(item)) })
}
function list(storage) { return read(storage).sessions }
function get(storage, id) { return list(storage).find(item => item.id === id) || null }
function remaining(storage) { return Math.max(0, LIMIT - read(storage).usedCount) }
function quotaError() { const error = new Error('本机的两次试答已使用，登录后可继续练习'); error.code = 'TRIAL_LIMIT'; return error }
function resumable(storage) { return list(storage).slice().reverse().find(item => item.status !== 'SUBMITTED') || null }
async function required(method, path, body) {
  const response = await http.request(method, path, body, { token: '' })
  if (!response.ok) throw Object.assign(new Error(response.reason || '读取试答失败，请联网后重试'), { code: response.code })
  return response.data
}
async function prepare(storage, options) {
  const saved = options.sessionId ? get(storage, options.sessionId) : options.resume === '1' ? resumable(storage) : null
  if (saved) return require('./question-assets.js').completeSnapshot(storage, saved).then(original => {
    const normalized = normalizePracticeOptions(original.route, getPreferences(storage))
    if (Object.keys(normalized).some(key => !original.route || original.route[key] !== normalized[key])) {
      original.route = Object.assign({}, original.route, normalized)
    }
    const record = read(storage)
    record.sessions = record.sessions.map(item => item.id === original.id ? original : item)
    put(storage, record)
    return original
  })
  if (options.sessionId) return Promise.reject(new Error('请登录原账号后恢复这次练习'))
  if (creating) return creating
  creating = create(storage, options).finally(() => { creating = null })
  return creating
}
async function create(storage, options, retried = false) {
  if (!remaining(storage)) throw quotaError()
  if (options.selectionKind && options.selectionKind !== 'NORMAL') throw new Error('登录后可按错题或收藏范围练习')
  if (!options.bankId) throw new Error('请选择一个题库开始试答')
  const bank = options.selectionKey && require('./remote-data-repository.js').getBankMeta(options.bankId) || await required('GET', '/question-banks/' + options.bankId)
  const bankIds = options.bankIds ? String(options.bankIds).split(',').filter(Boolean) : [options.bankId]
  const scope = { questionBankId: bank.id || options.bankId, count: Math.min(Number(options.count) || (bankIds.length > 1 ? 1000 : bank.questionCount || bank.activeQuestionCount || 20), 1000), order: ['practice', 'test'].includes(options.mode) ? 'RANDOM' : 'SEQUENTIAL', selectionKind: 'NORMAL', chapterIds: options.chapterId ? [options.chapterId] : [] }
  if (options.bankIds) scope.questionBankIds = bankIds
  if (options.ids) { scope.questionIds = String(options.ids).split(',').filter(Boolean); scope.count = scope.questionIds.length }
  let preview = options.selectionKey ? require('./remote-data-repository.js').getScopePreview(storage, options.selectionKey, bankIds) : null
  if (!preview && bankIds.length > 1) preview = await required('POST', '/practice/scope-preview', scope)
  if (preview) { scope.questionIds = preview.selectedQuestionIds; scope.count = preview.selectedCount; scope.order = 'SEQUENTIAL' }
  let snapshot
  try { snapshot = await required('POST', '/practice/trial-snapshots', { scope, expectedContentVersions: preview && preview.contentVersions || {}, expectedContentVersion: preview ? preview.contentVersion : bank.contentVersion, feedback: feedbackForMode(options), mode: options.mode || 'practice', timeLimitSeconds: timeLimitSeconds(options), }) } catch (error) {
    if (error.code === 'VERSION_CONFLICT' && !retried) return create(storage, { ...options, selectionKey: '' }, true)
    throw error
  }
  const gradingIds = new Set((snapshot && Array.isArray(snapshot.offlineGrading) ? snapshot.offlineGrading : []).map(grading => grading.itemId))
  if (!snapshot || !snapshot.id || !snapshot.items || !snapshot.items.length || !Array.isArray(snapshot.offlineGrading) || snapshot.items.some(item => !item.question || !gradingIds.has(item.itemId))) throw new Error('试答内容下载不完整，请重试')
  await require('./question-assets.js').completeSnapshot(storage, snapshot)
  snapshot.route = Object.assign({}, options, normalizePracticeOptions(null, getPreferences(storage)), { bankId: snapshot.questionBankId })
  snapshot.title = options.title || (bankIds.length > 1 ? `${bankIds.length} 个题库联合练习` : bank.name)
  snapshot.status = 'IN_PROGRESS'
  snapshot.currentIndex = 0
  snapshot.durationSeconds = 0
  snapshot = await vault.seal(storage, snapshot, 'guest')
  const record = read(storage)
  if (record.usedCount >= LIMIT) throw quotaError()
  record.sessions.push(snapshot)
  record.usedCount++
  // 快照与已用次数在同一次写入中保存；失败时不进入答题。
  try { put(storage, record) } catch (error) { vault.discard(snapshot, storage); throw error }
  vault.publish(snapshot)
  return snapshot
}
function quiz(snapshot) { return projection.quiz(snapshot) }
function restored(snapshot) { return projection.restored(snapshot) }
function save(storage, session) {
  const record = read(storage)
  const snapshot = record.sessions.find(item => item.id === session.meta.sessionId)
  if (!snapshot) throw new Error('试答记录不存在，无法保存')
  const state = JSON.parse(JSON.stringify(session.getPersistedState()))
  if ((!state.answers[state.currentIndex] || state.answers[state.currentIndex].confirmed === false) && session.state.selectedKeys.length) {
    state.answers[state.currentIndex] = { questionId: session.state.questions[state.currentIndex].id, selectedKeys: session.state.selectedKeys.slice(), confirmed: false, isCorrect: false }
  }
  snapshot.localState = state
  snapshot.status = state.status
  snapshot.updatedAt = new Date().toISOString()
  if (state.status === 'SUBMITTED') {
    const previous = snapshot.localResult
    snapshot.localResult = require('../models/client-result.js').result(session, snapshot)
    if (previous) Object.assign(snapshot.localResult, { submittedAt: previous.submittedAt, durationSeconds: previous.durationSeconds, objective: previous.objective })
  }
  put(storage, record)
}
function recent(storage) {
  return list(storage).slice().reverse().map(snapshot => ({ id: snapshot.id, questionBankId: snapshot.questionBankId, title: snapshot.title, questionBankName: snapshot.title, status: snapshot.status, mode: snapshot.route.mode, totalQuestions: snapshot.items.length, answeredCount: snapshot.localState ? snapshot.localState.answers.filter(answer => answer && answer.confirmed !== false).length : 0, createdAt: snapshot.createdAt }))
}
module.exports = { KEY, LIMIT, list, get, remaining, prepare, resumable, quiz, restored, save, recent }
