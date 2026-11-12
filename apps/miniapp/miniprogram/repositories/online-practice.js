const { timeLimitSeconds, feedbackForMode } = require('../utils/practice-presets.js')
const http = require('./http-gateway.js')
const auth = require('./auth-repository.js')
const { createSyncQueue } = require('./practice-sync-queue.js')
const assets = require('./question-assets.js')
const { getPreferences } = require('./preference-repository.js')
const { normalizePracticeOptions } = require('../utils/preferences.js')
const vault = require('./answer-vault.js')
const client = require('../models/client-result.js')
let runtime = null

const { summarize } = require('../models/practice-record-summary.js')
const { mapQuestion, quiz, restored } = require('../models/practice-snapshot.js')
function enable(storage) { runtime = new OnlinePractice(storage); return runtime }
function current() { return runtime }
class OnlinePractice {
  constructor(storage) { this.storage = storage; this.userId = ''; this.token = ''; this.queue = null; this.finishing = {}; this.creating = {}; this.assessing = {}; this.saveErrors = {}; this.statusListeners = new Set() }
  saveStatus(id) {
    if (this.saveErrors[id]) return { saveStatusText: '本次作答未能保存，请释放空间后重试', canRetrySync: true }
    const draft = this.queue && this.queue.get(id)
    if (draft && draft.paused && [401, 403].includes(draft.lastStatusCode)) return { saveStatusText: '请登录原账号，以便在其他设备查看练习记录', canRetrySync: true }
    if (draft && draft.failures) return { saveStatusText: '已保存在本机，可继续练习', canRetrySync: false }
    return { saveStatusText: '', canRetrySync: false }
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
      clearTimeout(this.assessmentTimer)
      this.userId = identity.userId
      vault.collect(this.storage)
      const queueUserId = this.userId
      this.queue = createSyncQueue({ storage: this.storage, userId: queueUserId, send: (id, command) => this.send(id, command, queueUserId), onChange: (id, draft) => {
        if (draft.lastAcknowledgedKey) this.storage.remove(`qandaOnline:${queueUserId}:${id}:wire:${draft.lastAcknowledgedKey}`)
        if (auth.getAuth(this.storage).userId === queueUserId) this.statusListeners.forEach(listener => { try { listener(id) } catch (_) {} })
      } })
    }
    if (this.token !== identity.token) {
      this.token = identity.token
      this.queue.resumeAuthOnly().catch(() => {})
      this.resumeAssessments().catch(() => {})
    }
    return identity
  }
  key(id) { return `qandaOnline:${this.userId}:${id}` }
  get(id) {
    this.identity()
    const snapshot = vault.restore(this.storage.get(this.key(id)) || null), task = this.queue && this.queue.get(id)
    if (snapshot && !snapshot.localResult && task && task.finish && task.payload.clientResult) {
      const changes = new Map(task.payload.progress.items.map(i => [i.itemId, i]))
      snapshot.localResult = { ...task.payload.clientResult, id, sessionId: id, version: snapshot.version, resultSource: 'CLIENT', durationSeconds: task.payload.progress.durationSeconds, submittedAt: task.payload.submittedAt, items: snapshot.items.map(i => ({ ...i, ...changes.get(i.itemId) })) }
      snapshot.localState = task.payload.state; snapshot.finishIntent = true
    }
    if (snapshot && task && task.finished && task.lastResponse && task.lastResponse.resultId) {
      snapshot.cloudConfirmed = true; snapshot.status = 'SUBMITTED'; snapshot.resultId = task.lastResponse.resultId; delete snapshot.finishIntent
    }
    return snapshot
  }
  put(id, value) {
    assets.reuseResultImages(value); this.storage.set(this.key(id), vault.strip(value))
    vault.publish(value)
    this.rememberSummary(value)
  }
  rememberSummary(snapshot) {
    const key = `qandaPracticeRecords:${this.userId}`
    const entries = this.storage.get(key) || {}, summary = summarize(snapshot, this.queue && this.queue.get(snapshot.id))
    if (JSON.stringify(entries[snapshot.id]) !== JSON.stringify(summary)) { entries[snapshot.id] = summary; this.storage.set(key, entries) }
  }
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
      let snapshot = await assets.completeSnapshot(this.storage, cached)
      if (this.userId !== userId || auth.getAuth(this.storage).userId !== userId) throw new Error('账号已切换，请重新打开练习')
      if (snapshot.offlineGrading && snapshot.offlineGrading.length) {
        snapshot = await vault.seal(this.storage, snapshot, userId)
        if (this.userId !== userId || auth.getAuth(this.storage).userId !== userId) {
          vault.discard(snapshot, this.storage)
          throw new Error('账号已切换，请重新打开练习')
        }
      }
      this.put(id, snapshot)
      const options = normalizePracticeOptions(snapshot.route, getPreferences(this.storage))
      if (Object.keys(options).some(key => !snapshot.route || snapshot.route[key] !== options[key])) {
        snapshot.route = Object.assign({}, snapshot.route, options)
        this.put(id, snapshot)
      }
      if (this.queue.get(id) && this.queue.get(id).finish && !snapshot.result) snapshot.finishIntent = true
      if (snapshot.status === 'IN_PROGRESS' && !snapshot.finishIntent) this.storage.set(`qandaOnlineLast:${userId}`, id)
      return snapshot
    }
    const remote = await this.required('GET', `/practice/sessions/${id}`)
    if (remote.status !== 'SUBMITTED') throw new Error('未找到本机的练习记录，请返回题库重新开始')
    remote.result = await this.required('GET', `/practice/sessions/${id}/result`)
    remote.items = remote.result.items
    remote.cloudConfirmed = true
    return this.remember(await vault.seal(this.storage, await assets.completeSnapshot(this.storage, remote)), options)
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
  async createPracticeIntent(userId, routeKey, options, retried = false) {
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
      intent = { routeKey, route: Object.assign({}, options, normalizePracticeOptions(null, getPreferences(this.storage))), key: http.uuid(), title: options.title || (bankIds.length > 1 ? `${bankIds.length} 个题库联合练习` : bank.name), body: { scope, expectedContentVersions: preview && preview.contentVersions || {}, expectedContentVersion: preview ? preview.contentVersion : bank.contentVersion, feedback: feedbackForMode(options), mode: options.mode || 'practice', timeLimitSeconds: timeLimitSeconds(options), deviceId: this.deviceId(), } }
      intents = this.storage.get(storageKey) || []
      this.storage.set(storageKey, intents.concat(intent))
    }
    const response = await this.call('POST', '/practice/sessions', intent.body, { idempotencyKey: intent.key })
    if (!response.ok) {
      if ([400, 404, 409, 422].includes(response.statusCode)) this.storage.set(storageKey, (this.storage.get(storageKey) || []).filter(value => value.key !== intent.key))
      if (response.statusCode === 409 && response.code === 'VERSION_CONFLICT') {
        await require('./remote-data-repository.js').loadBank(this.storage, intent.body.scope.questionBankId, { force: true })
        if (!retried) return this.createPracticeIntent(userId, routeKey, Object.assign({}, options, { selectionKey: '' }), true)
        throw new Error('题库正在更新，请稍后重试；本次配置已保留')
      }
      throw new Error(response.reason || '创建练习失败，请联网后重试')
    }
    const snapshot = response.data
    snapshot.title = intent.title
    const sealed = await vault.seal(this.storage, await assets.completeSnapshot(this.storage, snapshot))
    let created
    try { created = this.remember(sealed, intent.route) } catch (error) { vault.discard(sealed, this.storage); throw error }
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
      if (snapshot && (!snapshot.cloudConfirmed || snapshot.status !== 'SUBMITTED' || !(snapshot.result || snapshot.localResult) || Object.keys(snapshot.assessmentCommands || {}).length || this.finishing[`${this.userId}:${id}`] || this.assessing[`${this.userId}:${id}`])) { retained.push(id); continue }
      if (!this.queue.removeConfirmed(id)) { retained.push(id); continue }
      this.storage.remove(this.key(id))
    }
    this.storage.set(key, retained)
    vault.collect(this.storage)
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
    Object.assign(snapshot.route, normalizePracticeOptions(snapshot.route, getPreferences(this.storage)))
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
    if ((snapshot.status === 'SUBMITTED' && snapshot.result || snapshot.finishIntent)) { this.put(snapshot.id, snapshot); return { ok: true, unchanged: true } }
    const items = client.progress(session, snapshot)
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
      body = Object.assign({}, command.payload.progress, { clientResult: command.payload.clientResult, submittedAt: command.payload.submittedAt, kind: command.kind || 'SAVE', autoAddWrongBook: command.payload.autoAddWrongBook !== false, items: command.kind === 'FINISH' ? command.payload.progress.items : changes, expectedVersion: snapshot.version, writerToken: snapshot.writer.writerToken, clientSequence: command.sequence })
      this.storage.set(key, body)
    }
    const path = `/practice/sessions/${id}/sync-commands`
    let accepted = command.serverAccepted
    let reconciled = null
    if (!accepted && command.reconcile) {
      const known = await http.request('GET', `${path}/${command.idempotencyKey}`, null, { token: identity.token, priority: 'background' })
      if (known.ok) { accepted = true; reconciled = known }
      else if (known.statusCode !== 404) return known
    }
    let response = reconciled || (accepted
      ? await http.request('GET', `${path}/${command.idempotencyKey}`, null, { token: identity.token, priority: 'background' })
      : await http.request('POST', path, body, { token: identity.token, idempotencyKey: command.idempotencyKey, priority: 'background' }))
    if (auth.getAuth(this.storage).token !== identity.token || !this.storage.get(snapshotKey)) return { ok: false, statusCode: 401, reason: '账号状态已变化，请重新打开练习' }
    if (response.ok && response.data.state === 'REJECTED' && response.data.failure && [401, 403].includes(response.data.failure.status)) {
      response = await http.request('POST', path, body, { token: identity.token, idempotencyKey: command.idempotencyKey, priority: 'background' })
      if (auth.getAuth(this.storage).token !== identity.token || !this.storage.get(snapshotKey)) return { ok: false, statusCode: 401, reason: '账号状态已变化，请重新打开练习' }
    }
    if (response.ok) {
      const state = response.data
      if (state.state === 'REJECTED') return { ok: false, rejected: true, statusCode: state.failure.status, reason: state.failure.message }
      if (state.state === 'DEAD_LETTER') return { ok: false, statusCode: 409, reason: '进度处理失败，本机答案已保留，请稍后恢复同步' }
      if (state.state !== 'COMMITTED') return { ok: false, pending: true, serverState: state.state, reason: '已保存在本机，可继续练习', retryAfter: state.pollAfterMs || 1000 }
      if (!state.acknowledgement || !Number.isInteger(state.acknowledgement.acknowledgedSequence) || state.acknowledgement.acknowledgedSequence !== command.sequence || !Number.isInteger(state.acknowledgement.version) || !state.acknowledgement.writer) return { ok: false, statusCode: 503, reason: '答题进度仍在同步，本机答案已保留' }
      response = Object.assign({}, response, { data: state.acknowledgement, resultId: state.resultId })
    }
    if (response.ok) {
      const latest = this.get(id)
      if (response.data.version >= latest.version) {
        latest.version = response.data.version; latest.writer = response.data.writer
        latest.ackItems = latest.ackItems || {}
        body.items.forEach(item => { latest.ackItems[item.itemId] = item })
      }
      if (command.kind === 'FINISH' && !response.resultId) return { ok: false, statusCode: 503, reason: '已保存在本机，可继续练习' }
      if (command.kind === 'FINISH' && latest.localResult && response.resultId) {
        latest.cloudConfirmed = true; latest.resultId = response.resultId; latest.status = 'SUBMITTED'; delete latest.finishIntent
      }
      this.storage.set(snapshotKey, vault.strip(latest))
      this.rememberSummary(latest)
      if (response.resultId) { this.replayAssessments(id).catch(() => {}); this.trackCompleted(id); require('./remote-data-repository.js').invalidateLearning() }
    }
    return Object.assign({}, response, response.ok ? response.data : {})
  }
  async flush(id) { this.identity(); return this.queue.flush(id) }
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
    const snapshot = this.get(id), result = snapshot && (snapshot.localResult || snapshot.result)
    const item = result && result.items.find(i => i.itemId === itemId)
    if (!item || item.outcome !== 'SELF_RATED') throw new Error('只有已作答的简答题可以自评')
    const baseAssessment = item.selfAssessment || null
    item.selfAssessment = value
    const savedItem = snapshot.items.find(i => i.itemId === itemId); savedItem.selfAssessment = value
    if (snapshot.localState) { const index = snapshot.items.indexOf(savedItem); if (snapshot.localState.answers[index]) snapshot.localState.answers[index].selfAssessment = value }
    Object.assign(result, client.summary(result.items, result.items))
    snapshot.assessmentCommands = snapshot.assessmentCommands || {}
    const old = snapshot.assessmentCommands[itemId]
    snapshot.assessmentCommands[itemId] = old && old.body ? { ...old, nextValue: value } : { value, baseAssessment }
    this.put(id, snapshot)
    require('./remote-data-repository.js').invalidateLearning()
    this.replayAssessments(id).catch(() => {})
    return result
  }
  scheduleAssessments(until) {
    clearTimeout(this.assessmentTimer)
    this.assessmentTimer = setTimeout(() => this.resumeAssessments().catch(() => {}), Math.max(1000, until - Date.now()))
    if (this.assessmentTimer && this.assessmentTimer.unref) this.assessmentTimer.unref()
  }
  async resumeAssessments() {
    if (!auth.getAuth(this.storage).loggedIn || this.ratingInFlight) return
    const entries = this.storage.get(`qandaPracticeRecords:${this.identity().userId}`) || {}
    for (const id of Object.keys(entries)) {
      const snapshot = this.get(id)
      if (snapshot && snapshot.cloudConfirmed && Object.keys(snapshot.assessmentCommands || {}).length) await this.replayAssessments(id)
    }
  }
  async replayAssessments(id) {
    if (this.ratingInFlight) return
    const userId = this.identity().userId
    const cooldownKey = `qandaSyncCooldown:v1:${userId}`, cooldown = this.storage.get(cooldownKey) || { until: 0, failures: 0 }
    if (cooldown.until > Date.now()) { this.scheduleAssessments(cooldown.until); return }
    this.ratingInFlight = true
    try {
      while (true) {
        const snapshot = this.get(id)
        if (!snapshot || !snapshot.cloudConfirmed || !Object.keys(snapshot.assessmentCommands || {}).length) return
        const itemId = Object.keys(snapshot.assessmentCommands)[0], command = snapshot.assessmentCommands[itemId]
        if (!command.body) { command.body = { expectedVersion: snapshot.version, assessment: command.value }; command.key = http.uuid(); this.put(id, snapshot) }
        const response = await this.call('PUT', `/practice/sessions/${id}/items/${itemId}/self-assessment`, command.body, { idempotencyKey: command.key, priority: 'background' })
        if (this.identity().userId !== userId) return
        if (!response.ok) {
          if (!response.statusCode || response.statusCode === 429 || response.statusCode >= 500) {
            const old = this.storage.get(cooldownKey) || { failures: 0 }
            const delay = Math.max(response.retryAfter || 0, Math.min(300000, 10000 * 2 ** Math.min(old.failures, 6)) * (0.5 + Math.random() * 0.5))
            this.storage.set(cooldownKey, { until: Date.now() + delay, failures: old.failures + 1 }); this.scheduleAssessments(Date.now() + delay)
          } else if (response.statusCode === 409 && response.code === 'VERSION_CONFLICT') {
            const current = await this.call('GET', `/practice/sessions/${id}/result`, null, { priority: 'background' })
            if (current.ok) {
              const latest = this.get(id), pending = latest.assessmentCommands[itemId]
              latest.version = current.data.version; latest.assessmentCommands[itemId] = { value: pending.nextValue || command.body.assessment, baseAssessment: pending.baseAssessment }
              this.put(id, latest); this.scheduleAssessments(Date.now() + 1000)
            }
          }
          return
        }
        this.storage.remove(cooldownKey)
        const latest = this.get(id), pending = latest.assessmentCommands[itemId]
        latest.version = response.data.version
        if (pending.nextValue && pending.nextValue !== command.body.assessment) latest.assessmentCommands[itemId] = { value: pending.nextValue, baseAssessment: command.body.assessment }
        else delete latest.assessmentCommands[itemId]
        this.put(id, latest)
        require('./remote-data-repository.js').invalidateLearning()
      }
    } finally { this.ratingInFlight = false }
  }
  async finishSession(session) {
    const id = session.meta.sessionId
    let snapshot = this.get(id)
    if (!snapshot) throw new Error('未找到本机练习')
    if (snapshot.localResult) return snapshot.localResult
    if (snapshot.result) return snapshot.result
    const localResult = client.result(session, snapshot)
    // Publish the finish intent before reporting completion; retries keep this exact payload.
    snapshot.localState = session.getPersistedState()
    const items = client.progress(session, snapshot)
    const payload = { submittedAt: localResult.submittedAt, progress: { currentIndex: session.state.currentIndex, durationSeconds: localResult.durationSeconds, items }, state: session.getPersistedState(), clientResult: { totalCount: localResult.totalCount, answeredCount: localResult.answeredCount, objective: localResult.objective, shortAnswer: localResult.shortAnswer }, autoAddWrongBook: session.preferences.autoAddWrongBook }
    const saved = this.queue.finish(id, payload)
    if (!saved.ok) throw new Error(saved.reason)
    snapshot.autoAddWrongBook = session.preferences.autoAddWrongBook; snapshot.localResult = localResult; snapshot.finishIntent = true; snapshot.localState = session.getPersistedState()
    // The complete queue payload is the durable finish record; summary writes can be rebuilt from it.
    try { this.put(id, snapshot) } catch (_) { /* Keep the already durable finish intent. */ }
    this.queue.flush(id).catch(() => {})
    return localResult
  }



}
module.exports = { enable, current, OnlinePractice, mapQuestion }
