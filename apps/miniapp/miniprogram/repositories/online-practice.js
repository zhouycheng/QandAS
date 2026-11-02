const http = require('./http-gateway.js')
const auth = require('./auth-repository.js')
const { createSyncQueue } = require('./practice-sync-queue.js')
const assets = require('./question-assets.js')
let runtime = null

const { mapQuestion, quiz, restored } = require('../models/practice-snapshot.js')
function enable(storage) { runtime = new OnlinePractice(storage); return runtime }
function current() { return runtime }
class OnlinePractice {
  constructor(storage) { this.storage = storage; this.userId = ''; this.token = ''; this.queue = null; this.finishing = {}; this.creating = {}; this.assessing = {}; this.saveErrors = {}; this.statusListeners = new Set() }
  saveStatus(id) {
    if (this.saveErrors[id]) return { saveStatusText: '本机保存失败，请重试', canRetrySync: true }
    const draft = this.queue && this.queue.get(id)
    if (!draft || (!draft.pending && draft.sequence <= draft.acknowledgedSequence)) return { saveStatusText: '服务器已保存', canRetrySync: false }
    if (draft.paused || draft.failures) return { saveStatusText: '本机已保存 · ' + (draft.reason || '等待同步'), canRetrySync: true }
    return { saveStatusText: draft.pending && draft.pending.serverAccepted ? '本机已保存 · 服务器处理中' : '本机已保存 · 等待同步', canRetrySync: false }
  }
  observeStatus(id, listener) {
    const owner = this.userId
    const update = (changedId) => { if (changedId === id && auth.getAuth(this.storage).userId === owner) listener(this.saveStatus(id)) }
    this.statusListeners.add(update); update(id)
    return () => this.statusListeners.delete(update)
  }
  identity() {
    const identity = auth.getAuth(this.storage)
    if (!identity.loggedIn || !identity.token) throw new Error('请先登录')
    if (this.userId !== identity.userId) {
      if (this.queue) this.queue.stop()
      this.userId = identity.userId
      const queueUserId = this.userId
      this.queue = createSyncQueue({ storage: this.storage, userId: queueUserId, send: (id, command) => this.send(id, command, queueUserId), onChange: (id, draft) => {
        if (draft.lastAcknowledgedKey) this.storage.remove(`qandaOnline:${queueUserId}:${id}:wire:${draft.lastAcknowledgedKey}`)
        if (auth.getAuth(this.storage).userId === queueUserId) this.statusListeners.forEach(listener => { try { listener(id) } catch (_) {} })
      } })
    }
    if (this.token !== identity.token) {
      this.token = identity.token
      this.queue.resumeAuthOnly().catch(() => {})
    }
    return identity
  }
  key(id) { return `qandaOnline:${this.userId}:${id}` }
  get(id) { this.identity(); return this.storage.get(this.key(id)) || null }
  put(id, value) { assets.reuseResultImages(value); this.storage.set(this.key(id), value) }
  deviceId() {
    let id = this.storage.get('qandaDeviceId')
    if (!id) { id = http.uuid(); this.storage.set('qandaDeviceId', id) }
    return id
  }
  async call(method, path, body, options) {
    const identity = this.identity()
    const response = await http.request(method, path, body, Object.assign({ token: identity.token }, options))
    if (auth.getAuth(this.storage).userId !== identity.userId) return { ok: false, statusCode: 401, reason: '账号已切换，请重新打开练习' }
    return response
  }
  async required(method, path, body, options) {
    const response = await this.call(method, path, body, options)
    if (!response.ok) throw new Error(response.reason || '请求失败，请重试')
    return response.data
  }
  async prepare(options) {
    const userId = this.identity().userId
    const id = options.sessionId || (options.resume === '1' ? this.storage.get(`qandaOnlineLast:${userId}`) : '')
    if (!id) return this.createPractice(options)
    const cached = this.get(id)
    if (cached) {
      if (cached.writer && cached.writer.deviceId !== this.deviceId() && cached.status !== 'SUBMITTED') throw new Error('请在创建练习的设备上继续答题')
      const snapshot = await assets.completeSnapshot(this.storage, cached)
      if (auth.getAuth(this.storage).userId !== userId) throw new Error('账号已切换，请重新打开练习')
      if (snapshot.status === 'IN_PROGRESS') this.storage.set(`qandaOnlineLast:${userId}`, id)
      return snapshot
    }
    const remote = await this.required('GET', `/practice/sessions/${id}`)
    if (remote.status !== 'SUBMITTED') throw new Error('未找到本机的练习记录，请返回题库重新开始')
    remote.result = await this.required('GET', `/practice/sessions/${id}/result`)
    remote.items = remote.result.items
    return this.remember(await assets.completeSnapshot(this.storage, remote), options)
  }
  createPractice(options) {
    const userId = this.identity().userId
    const route = {}
    Object.keys(options).sort().filter(key => key !== 'sessionId' && key !== 'resume').forEach(key => { route[key] = options[key] })
    const routeKey = JSON.stringify(route)
    const key = `${userId}:${routeKey}`
    if (this.creating[key]) return this.creating[key]
    this.creating[key] = this.createPracticeIntent(userId, routeKey, route).then((result) => { delete this.creating[key]; return result }, (error) => { delete this.creating[key]; throw error })
    return this.creating[key]
  }
  async createPracticeIntent(userId, routeKey, options) {
    const storageKey = `qandaOnlineCreate:${userId}`
    let intents = this.storage.get(storageKey) || []
    let intent = intents.find(value => value.routeKey === routeKey)
    if (!intent) {
      const bankId = options.bankId
      if (!bankId) throw new Error('请选择一个题库开始练习')
      const bank = options.selectionKey && require('./remote-data-repository.js').getBankMeta(bankId) || await this.required('GET', `/question-banks/${bankId}`)
      if (this.identity().userId !== userId) throw new Error('账号已切换，请重新打开练习')
      const bankIds = options.bankIds ? String(options.bankIds).split(',').filter(Boolean) : [bankId]
      const scope = { questionBankId: bankId, count: Math.min(Number(options.count) || (bankIds.length > 1 ? 1000 : bank.questionCount || 20), 1000), order: ['practice', 'test'].includes(options.mode) ? 'RANDOM' : 'SEQUENTIAL', selectionKind: options.selectionKind || 'NORMAL', chapterIds: options.chapterId ? [options.chapterId] : [] }
      if (options.bankIds) scope.questionBankIds = bankIds
      scope.collectionChip = options.collectionChip || 'all'
      if (options.ids) { scope.questionIds = String(options.ids).split(',').filter(Boolean); scope.count = scope.questionIds.length }
      let preview = options.selectionKey ? require('./remote-data-repository.js').getScopePreview(this.storage, options.selectionKey, bankIds) : null
      if (!preview && bankIds.length > 1) preview = await this.required('POST', '/practice/scope-preview', scope)
      if (preview) { scope.questionIds = preview.selectedQuestionIds; scope.count = preview.selectedCount; scope.order = 'SEQUENTIAL' }
      intent = { routeKey, route: options, key: http.uuid(), title: options.title || (bankIds.length > 1 ? `${bankIds.length} 个题库联合练习` : bank.name), body: { scope, expectedContentVersions: preview && preview.contentVersions || {}, expectedContentVersion: preview ? preview.contentVersion : bank.contentVersion, feedback: options.feedback || (options.mode === 'test' ? 'AFTER_FINISH' : 'IMMEDIATE'), mode: options.mode || 'practice', timeLimitSeconds: options.mode === 'view' ? null : options.duration || options.mode === 'test' ? (Number(options.duration) || 10) * 60 : null, deviceId: this.deviceId() } }
      intents = this.storage.get(storageKey) || []
      this.storage.set(storageKey, intents.concat(intent))
    }
    const response = await this.call('POST', '/practice/sessions', intent.body, { idempotencyKey: intent.key })
    if (!response.ok) {
      if ([400, 404, 409, 422].includes(response.statusCode)) this.storage.set(storageKey, (this.storage.get(storageKey) || []).filter(value => value.key !== intent.key))
      if (response.statusCode === 409 && response.code === 'VERSION_CONFLICT') {
        await require('./remote-data-repository.js').loadBank(this.storage, intent.body.scope.questionBankId, { force: true })
        throw new Error('题库内容已更新，请返回题库重新确认答题配置；已有练习已保留')
      }
      throw new Error(response.reason || '创建练习失败，请联网后重试')
    }
    const snapshot = response.data
    snapshot.title = intent.title
    const created = this.remember(await assets.completeSnapshot(this.storage, snapshot), intent.route)
    this.storage.set(storageKey, (this.storage.get(storageKey) || []).filter(value => value.key !== intent.key))
    return created
  }
  trackCompleted(id) {
    const key = `qandaOnlineCompleted:${this.identity().userId}`
    const previous = this.storage.get(key) || []
    this.storage.set(key, [id].concat(previous.filter((value) => value !== id)))
    this.pruneCompleted()
  }
  pruneCompleted() {
    const key = `qandaOnlineCompleted:${this.identity().userId}`
    const completed = this.storage.get(key) || []
    const retained = []
    for (const id of completed) {
      if (retained.length < 5) { retained.push(id); continue }
      const snapshot = this.get(id)
      if (snapshot && (snapshot.status !== 'SUBMITTED' || !snapshot.result || Object.keys(snapshot.assessmentCommands || {}).length || this.finishing[`${this.userId}:${id}`] || this.assessing[`${this.userId}:${id}`])) { retained.push(id); continue }
      if (!this.queue.removeConfirmed(id)) { retained.push(id); continue }
      this.storage.remove(this.key(id))
    }
    this.storage.set(key, retained)
  }
  snapshotRoute(snapshot) {
    const config = snapshot.configuration
    if (!config) return snapshot.questionBankId ? { bankId: snapshot.questionBankId } : {}
    return {
      bankId: snapshot.questionBankId,
      bankIds: (config.questionBankIds || []).join(','),
      mode: config.mode || (snapshot.feedback === 'AFTER_FINISH' ? 'test' : config.order === 'SEQUENTIAL' ? 'order' : 'practice'),
      chapterId: (config.chapterIds || [])[0] || '',
      duration: config.timeLimitSeconds ? String(config.timeLimitSeconds / 60) : '',
      count: config.count,
      selectionKind: config.selectionKind,
      collectionChip: config.collectionChip || 'all'
    }
  }
  remember(snapshot, options) {
    const previous = this.get(snapshot.id)
    snapshot.title = snapshot.title || previous && previous.title || ((snapshot.configuration && snapshot.configuration.questionBankIds || []).length > 1 ? `${snapshot.configuration.questionBankIds.length} 个题库联合练习` : '')
    snapshot.route = Object.assign({}, this.snapshotRoute(snapshot), previous && previous.route || {}, snapshot.route || {}, options || {})
    snapshot.formatVersion = 1
    this.put(snapshot.id, snapshot)
    this.storage.set(`qandaOnlineLast:${this.userId}`, snapshot.id)
    if (snapshot.status === 'SUBMITTED' && snapshot.result) this.trackCompleted(snapshot.id)
    else this.pruneCompleted()
    return snapshot
  }
  async completeView(session) {
    const id = session.meta.sessionId
    const snapshot = this.get(id)
    const key = `qandaViewClosures:${this.userId}`
    const pending = this.storage.get(key) || {}
    if (!pending[id]) {
      pending[id] = { key: http.uuid(), body: { expectedVersion: snapshot.version, writerToken: snapshot.writer.writerToken } }
      this.storage.set(key, pending)
    }
    snapshot.viewCompleted = true
    this.put(id, snapshot)
    await this.flushViewClosures()
  }
  async flushViewClosures() {
    const userId = this.identity().userId
    if (this.closingViews === userId) return
    this.closingViews = userId
    const key = `qandaViewClosures:${userId}`
    try {
      for (const [id, command] of Object.entries(this.storage.get(key) || {})) {
        if (command.paused || this.identity().userId !== userId) continue
        const response = await this.call('POST', `/practice/sessions/${id}/cancel`, command.body, { idempotencyKey: command.key })
        if (this.identity().userId !== userId) return
        const pending = this.storage.get(key) || {}
        if (response.ok) {
          const snapshot = this.get(id)
          if (snapshot) this.put(id, Object.assign({}, snapshot, { status: 'CANCELLED', version: response.data.version }))
          delete pending[id]
          require('./remote-data-repository.js').invalidateLearning()
        } else if ([400, 401, 403, 404, 409, 422].includes(response.statusCode)) {
          pending[id] = Object.assign({}, command, { paused: true, reason: response.reason })
        }
        this.storage.set(key, pending)
        if (!response.ok) break
      }
    } finally { if (this.closingViews === userId) this.closingViews = '' }
  }
  quiz(snapshot) { return quiz(snapshot) }
  restored(snapshot) { return restored(snapshot) }
  save(session) {
    const id = session.getPersistedState().sessionId
    try { const result = this.saveLocal(session); delete this.saveErrors[id]; return result }
    catch (error) { this.saveErrors[id] = true; throw error }
    finally { this.statusListeners.forEach(listener => { try { listener(id) } catch (_) {} }) }
  }
  saveLocal(session) {
    this.identity()
    const state = JSON.parse(JSON.stringify(session.getPersistedState()))
    if ((!state.answers[state.currentIndex] || state.answers[state.currentIndex].confirmed === false) && session.state.selectedKeys.length) {
      state.answers[state.currentIndex] = { questionId: session.state.questions[state.currentIndex].id, selectedKeys: session.state.selectedKeys.slice(), confirmed: false, isCorrect: false }
    }
    const snapshot = this.get(state.sessionId)
    if (!snapshot) throw new Error('未找到这次练习，请返回题库重新打开')
    snapshot.localState = state
    if (snapshot.status === 'SUBMITTED' && snapshot.result) { this.put(snapshot.id, snapshot); return { ok: true, unchanged: true } }
    const items = snapshot.items.map((item, i) => {
      const answer = session.state.answers[i]
      const question = session.state.questions[i]
      const editing = i === state.currentIndex && (!answer || answer.confirmed === false)
      const keys = editing ? session.state.selectedKeys : answer ? answer.selectedKeys : []
      return { itemId: item.itemId, answer: question.isFillBlank ? (answer && answer.blanks && answer.blanks.some(value => value.trim()) ? { blanks: answer.blanks } : null) : question.isShortAnswer ? (answer && answer.text && answer.text.trim() ? { text: answer.text } : null) : keys && keys.length ? (question.type === 'TRUE_FALSE' ? { value: keys[0] === 'true' } : { optionKeys: keys }) : null, confirmed: !!answer && answer.confirmed !== false, marked: state.markedIds.includes(item.question.id) }
    })
    this.put(snapshot.id, snapshot)
    const saved = this.queue.save(snapshot.id, { progress: { currentIndex: state.currentIndex, durationSeconds: state.elapsedTime, items }, state })
    if (!saved.ok) throw new Error(saved.reason || '本机存储失败，请释放空间后重试')
    return saved
  }
  async send(id, command, queueUserId) {
    const identity = auth.getAuth(this.storage)
    if (!identity.loggedIn || identity.userId !== queueUserId) return { ok: false, statusCode: 401, reason: '请登录原账号后同步答题数据' }
    const snapshotKey = `qandaOnline:${queueUserId}:${id}`
    const snapshot = this.storage.get(snapshotKey)
    if (!snapshot || !snapshot.writer) return { ok: false, statusCode: 409, reason: '暂时无法保存这次练习，请重新打开' }
    const key = `${snapshotKey}:wire:${command.idempotencyKey}`
    let body = this.storage.get(key)
    if (!body) {
      const acknowledged = snapshot.ackItems || {}
      const changes = command.payload.progress.items.filter(item => JSON.stringify(acknowledged[item.itemId]) !== JSON.stringify(item))
      body = Object.assign({}, command.payload.progress, { items: changes, expectedVersion: snapshot.version, writerToken: snapshot.writer.writerToken, clientSequence: command.sequence })
      this.storage.set(key, body)
    }
    const path = `/practice/sessions/${id}/progress-commands`
    let response = command.serverAccepted
      ? await http.request('GET', `${path}/${command.idempotencyKey}`, null, { token: identity.token, priority: 'background' })
      : await http.request('POST', path, body, { token: identity.token, idempotencyKey: command.idempotencyKey, priority: 'background' })
    if (response.ok) {
      const state = response.data
      if (state.state === 'REJECTED') return { ok: false, rejected: true, statusCode: state.failure.status, reason: state.failure.message }
      if (state.state === 'DEAD_LETTER') return { ok: false, statusCode: 409, reason: '进度处理失败，本机答案已保留，请稍后恢复同步' }
      if (state.state !== 'COMMITTED') return { ok: false, pending: true, serverState: state.state, reason: '本机已保存，服务器处理中' }
      if (!state.acknowledgement || !Number.isInteger(state.acknowledgement.acknowledgedSequence) || state.acknowledgement.acknowledgedSequence !== command.sequence || !Number.isInteger(state.acknowledgement.version) || !state.acknowledgement.writer) return { ok: false, statusCode: 503, reason: '答题进度仍在同步，本机答案已保留' }
      response = Object.assign({}, response, { data: state.acknowledgement })
    }
    if (response.ok) {
      const latest = this.storage.get(snapshotKey)
      if (response.data.version >= latest.version) {
        latest.version = response.data.version; latest.writer = response.data.writer
        latest.ackItems = latest.ackItems || {}
        body.items.forEach(item => { latest.ackItems[item.itemId] = item })
      }
      this.storage.set(snapshotKey, latest)
    }
    return Object.assign({}, response, response.ok ? response.data : {})
  }
  async flush(id) { this.identity(); return this.queue.flush(id) }
  async awaitConfirmed(id) {
    const deadline = Date.now() + 15000
    while (true) {
      const pending = this.queue.get(id)
      if (!pending || (!pending.pending && pending.sequence <= pending.acknowledgedSequence)) return
      const response = await this.flush(id)
      if (response.ok) continue
      if (!(response.pending || response.deferred) || Date.now() >= deadline) throw new Error(response.reason || '进度正在保存，请稍后重试')
      await new Promise(resolve => setTimeout(resolve, Math.min(response.retryAfter || 1000, 1000)))
    }
  }
  finish(session) {
    const key = `${this.identity().userId}:${session.meta.sessionId}`
    if (this.finishing[key]) return this.finishing[key]
    this.finishing[key] = this.finishSession(session).then((result) => { delete this.finishing[key]; return result }, (error) => { delete this.finishing[key]; throw error })
    return this.finishing[key]
  }
  assess(id, itemId, value) {
    const userId = this.identity().userId
    const key = `${userId}:${id}`
    const previous = this.assessing[key] || Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.assessSession(id, itemId, value, userId))
    this.assessing[key] = operation
    return operation.then(result => { if (this.assessing[key] === operation) delete this.assessing[key]; return result }, error => { if (this.assessing[key] === operation) delete this.assessing[key]; throw error })
  }
  async assessSession(id, itemId, value, userId) {
    if (!['CORRECT', 'WRONG'].includes(value)) throw new Error('自评结果无效')
    if (this.identity().userId !== userId) throw new Error('账号已切换，请重新打开练习')
    const snapshot = this.get(id)
    if (!snapshot || snapshot.status !== 'SUBMITTED' || !snapshot.result) throw new Error('正在确认交卷，请稍后自评')
    snapshot.assessmentCommands = snapshot.assessmentCommands || {}
    snapshot.assessed = snapshot.assessed || {}
    const replay = async pendingItemId => {
      const command = snapshot.assessmentCommands[pendingItemId]
      const rated = await this.required('PUT', `/practice/sessions/${id}/items/${pendingItemId}/self-assessment`, command.body, { idempotencyKey: command.key })
      snapshot.version = rated.version
      snapshot.result = rated
      snapshot.assessed[pendingItemId] = command.body.assessment
      delete snapshot.assessmentCommands[pendingItemId]
      this.put(id, snapshot)
    }
    for (const pendingItemId of Object.keys(snapshot.assessmentCommands)) await replay(pendingItemId)
    if (snapshot.assessed[itemId] === value) return snapshot.result
    snapshot.assessmentCommands[itemId] = { key: http.uuid(), body: { expectedVersion: snapshot.version, assessment: value } }
    this.put(id, snapshot)
    await replay(itemId)
    return snapshot.result
  }
  async finishSession(session) {
    const id = session.meta.sessionId
    let snapshot = this.get(id)
    if (!snapshot) throw new Error('未找到这次练习，请返回题库重新打开')
    if (!snapshot.finishCommand && !snapshot.result) {
      this.save(session)
      await this.awaitConfirmed(id)
      snapshot = this.get(id)
      snapshot.finishCommand = { key: http.uuid(), body: { expectedVersion: snapshot.version, durationSeconds: session.getElapsedSeconds(), items: [], writerToken: snapshot.writer.writerToken, autoAddWrongBook: session.preferences.autoAddWrongBook } }
      this.put(id, snapshot)
    }
    if (!snapshot.result) {
      const result = await this.required('POST', `/practice/sessions/${id}/finish`, snapshot.finishCommand.body, { idempotencyKey: snapshot.finishCommand.key })
      snapshot.result = result; snapshot.status = 'SUBMITTED'; snapshot.version = result.version
      this.put(id, snapshot)
    }
    snapshot.assessed = snapshot.assessed || {}
    for (let index = 0; index < session.state.answers.length; index += 1) {
      const answer = session.state.answers[index]
      const itemId = snapshot.items[index].itemId
      if (!answer || !answer.selfAssessment || snapshot.assessed[itemId] === answer.selfAssessment) continue
      await this.assess(id, itemId, answer.selfAssessment)
      snapshot = this.get(id)
    }
    this.trackCompleted(id)
    return snapshot.result
  }

}
module.exports = { enable, current, OnlinePractice, mapQuestion }
