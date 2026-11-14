const vault = require('../repositories/answer-vault.js');
const { getDefaultPracticeRoute } = require('../repositories/preference-repository.js');
const { routeQuery } = require('../utils/practice-presets.js');
const practiceRepository = require('../repositories/practice-repository.js');
const onlinePractice = require('../repositories/online-practice.js');
const trials = require('../repositories/trial-practice.js');
const { DEFAULT_TEST_DURATION_MINUTES, PracticeSession, getInitialPracticeViewData } = require('../models/practice-session.js');
const { SESSION_STATUS, SYNC_STATUS } = require('../models/practice-session-state.js');
const { normalizePracticeOptions } = require('../utils/preferences.js');
function decodeOptionValue(value) {
    return value ? decodeURIComponent(value) : '';
}
function createNullStorage() {
    return {
        get() {
            return 0;
        },
        set() { },
        remove() { }
    };
}
class PracticeViewModel {
    constructor(options) {
        const normalizedOptions = options || {};
        this.repository = normalizedOptions.repository || practiceRepository;
        this.storage = normalizedOptions.storage || createNullStorage();
        this.session = null;
        // 落盘去重用：游标不变就不重复写 storage（多选题连点会触发大量无意义写入）
        this.persistCursor = null;
    }
    static getInitialData() {
        return getInitialPracticeViewData();
    }
    async loadOnline(options) {
        this.trial = false;
        this.online = onlinePractice.current();
        this.ownerId = this.online.identity().userId;
        this.routeOptions = options || {};
        const snapshot = await this.online.prepare(this.routeOptions);
        this.routeOptions = Object.assign({}, this.routeOptions, snapshot.route || {});
        this.online.activeId = snapshot.id;
        this.answerSnapshot = snapshot;
        this.revisionUpdates = snapshot.revisionUpdates || [];
        const quiz = this.online.quiz(snapshot);
        await vault.hydrate(this.storage, snapshot, quiz.questions, (snapshot.localResult || snapshot.result) && options.review !== '1' ? quiz.questions.map((_, i) => i) : [snapshot.localState && snapshot.localState.currentIndex || snapshot.currentIndex || 0]);
        const restored = this.online.restored(snapshot);
        this.session = new PracticeSession({ quiz, restored, mode: snapshot.configuration && snapshot.configuration.mode || (snapshot.feedback === 'AFTER_FINISH' ? 'test' : (this.routeOptions.mode || 'practice')), feedback: snapshot.feedback,
            config: snapshot.route, isTimed: snapshot.configuration && snapshot.configuration.mode ? !!snapshot.configuration.timeLimitSeconds : snapshot.route.duration === '0' ? false : undefined, timeLimitSeconds: snapshot.configuration && snapshot.configuration.timeLimitSeconds, durationMinutes: snapshot.configuration && snapshot.configuration.timeLimitSeconds ? snapshot.configuration.timeLimitSeconds / 60 : Number(snapshot.route.duration) || DEFAULT_TEST_DURATION_MINUTES, preferences: this.repository.getPreferences(this.storage),
            favoriteQuestionIds: snapshot.favoriteQuestionIds || [] });
        this.session.reset();
        this.session.restore(restored);
        this.editingLocked = false;
        if (options.review === '1' || snapshot.finishIntent && !snapshot.localResult) {
            this.readOnlyReview = true;
            this.session.state.isViewMode = true;
            this.session.state.review = true;
            this.session.state.reviewPending = !snapshot.localResult && !snapshot.result && snapshot.feedback !== 'IMMEDIATE';
            this.session.state.awaitingResult = !snapshot.localResult && !snapshot.result;
            this.session.state.isCompleted = false;
            this.session.state.isTimed = false;
            this.session.showQuestionAtIndex(this.session.state.currentIndex || 0);
            return { data: Object.assign(this.session.getViewData(), { editingLocked: false, awaitingResult: !snapshot.localResult && !snapshot.result, reviewPending: this.session.state.reviewPending, loadError: '' }), startTimer: false, stopTimer: true };
        }
        if (restored.status === SESSION_STATUS.SUBMITTED) {
            this.session.state.isCompleted = true;
            this.session.finish();
            if (snapshot.localResult || snapshot.result)
                this.applyOfficialResult(snapshot.localResult || snapshot.result);
            else if (snapshot.status !== 'SUBMITTED') {
                const outcome = await this.resolveSubmitOutcome({ data: this.session.getViewData() });
                return Object.assign({}, outcome, {
                    data: Object.assign(this.session.getViewData(), { editingLocked: false, loadError: '' }),
                    startTimer: false,
                    stopTimer: true
                });
            }
        }
        return { data: Object.assign(this.session.getViewData(), { editingLocked: false, loadError: '' }), startTimer: this.session.state.isTimed };
    }
    async checkWriter() {
        if (!this.online || this.repository.getAuth(this.storage).userId === this.ownerId)
            return null;
        this.editingLocked = true;
        this.session = null;
        return { data: PracticeViewModel.getInitialData(), command: { type: 'navigate', url: '/page/login/index' } };
    }
    async checkContentUpdates() {
        if (!this.answerSnapshot || !this.session) return null;
        const expected = this.session;
        try {
            const updates = await require('../repositories/content-revisions.js').check(this.storage, this.answerSnapshot);
            if (this.session !== expected) return null;
            this.revisionUpdates = updates;
            this.answerSnapshot.revisionUpdates = updates;
            if (this.online) {
                const snapshot = this.online.get(this.answerSnapshot.id);
                if (snapshot) this.online.put(snapshot.id, { ...snapshot, revisionUpdates: updates });
            }
            return { data: this.contentUpdateData() };
        } catch (_) { return null; }
    }
    contentUpdateData() {
        const byId = new Map((this.revisionUpdates || []).map(row => [row.questionId, row]));
        const update = byId.get((this.session && this.session.getCurrentBaseQuestion() || {}).id);
        const data = { contentUpdateText: update ? this.session.state.isCompleted || this.readOnlyReview ? '题目已更新' : '题目已有更新，本次练习继续使用开始时的内容' : '', canViewLatest: !!(update && update.available) };
        if (this.session && this.session.state.isCompleted) {
            const items = this.session.state.resultItems.map(item => ({ ...item, contentUpdated: byId.has(item.id), latestAvailable: !!(byId.get(item.id) || {}).available }));
            this.session.state.resultItems = items;
            this.session.state.filteredResultItems = this.session.state.filteredResultItems.map(item => items.find(row => row.id === item.id));
            Object.assign(data, { resultItems: items, filteredResultItems: this.session.state.filteredResultItems });
        }
        return data;
    }
    viewLatestQuestion(questionId) {
        const question = this.session && (questionId ? this.session.state.questions.find(q => q.id === questionId) : this.session.getCurrentBaseQuestion());
        if (!question) return null;
        return { command: { type: 'navigate', url: '/page/question-detail/index?latest=1&id=' + encodeURIComponent(question.id) } };
    }
    observeSaveStatus(listener) {
        return this.online && this.session ? this.online.observeStatus(this.session.meta.sessionId, data => {
            if (this.readOnlyReview && this.session.state.awaitingResult) {
                const snapshot = this.online.get(this.session.meta.sessionId);
                if (snapshot && snapshot.result) {
                    const index = this.session.state.currentIndex;
                    this.session.state.isViewMode = false;
                    this.applyOfficialResult(snapshot.result);
                    this.session.state.isViewMode = true;
                    this.session.state.reviewPending = false;
                    this.session.state.awaitingResult = false;
                    this.session.state.isCompleted = false;
                    this.session.showQuestionAtIndex(index);
                    data = Object.assign({}, data, this.session.getViewData(), { reviewPending: false, awaitingResult: false });
                }
            }
            listener(data);
        }) : () => { };
    }
    async retrySync() {
        if (!this.online || !this.session)
            return null;
        try {
            this.online.save(this.session);
        }
        catch (error) {
            return { data: this.online.saveStatus(this.session.meta.sessionId), command: { type: 'toast', title: error.message } };
        }
        const result = await this.online.queue.resume(this.session.meta.sessionId);
        return { data: this.online.saveStatus(this.session.meta.sessionId), command: !result.ok && !result.pending ? { type: 'toast', title: result.reason } : null };
    }
    /** 固定快照恢复作答，题目修订与答案资料保持配套。 */
    load(options) { const route = options || {}; const savedTrial = route.sessionId && trials.get(this.storage, route.sessionId); return savedTrial || !this.repository.getAuth(this.storage).loggedIn ? this.loadTrial(route) : this.loadOnline(route); }
    async loadTrial(options) {
        this.online = null;
        this.trial = true;
        this.routeOptions = options;
        let snapshot;
        try {
            snapshot = await trials.prepare(this.storage, options);
        }
        catch (error) {
            if (error.code === 'TRIAL_LIMIT')
                return { data: { loadError: error.message }, command: { type: 'trialLogin' } };
            throw error;
        }
        this.routeOptions = snapshot.route;
        this.answerSnapshot = snapshot;
        this.revisionUpdates = snapshot.revisionUpdates || [];
        const trialQuiz = trials.quiz(snapshot);
        await vault.hydrate(this.storage, snapshot, trialQuiz.questions, snapshot.status === 'SUBMITTED' ? trialQuiz.questions.map((_, i) => i) : [snapshot.localState && snapshot.localState.currentIndex || 0]);
        const restored = trials.restored(snapshot);
        this.session = new PracticeSession({ quiz: trialQuiz, restored, config: snapshot.route, mode: snapshot.route.mode || 'practice', feedback: snapshot.feedback, isTimed: snapshot.configuration && snapshot.configuration.mode ? !!snapshot.configuration.timeLimitSeconds : snapshot.route.duration === '0' ? false : undefined, timeLimitSeconds: snapshot.configuration && snapshot.configuration.timeLimitSeconds, durationMinutes: snapshot.configuration && snapshot.configuration.timeLimitSeconds ? snapshot.configuration.timeLimitSeconds / 60 : Number(snapshot.route.duration) || DEFAULT_TEST_DURATION_MINUTES, preferences: this.repository.getPreferences(this.storage) });
        this.session.reset();
        this.session.restore(restored);
        if (restored.status === SESSION_STATUS.SUBMITTED) {
            this.session.state.isCompleted = true; this.session.finish();
            if (snapshot.localResult) this.applyOfficialResult(snapshot.localResult);
        }
        this.session.updateSyncStatus(SYNC_STATUS.LOCAL_ONLY);
        this.session.state.trialNotice = `游客试答 · 记录保存在本机 · 剩余 ${trials.remaining(this.storage)} 次`;
        return { data: Object.assign(this.session.getViewData(), { loadError: '' }), startTimer: this.session.state.isTimed && !this.session.state.isCompleted };
    }
    withAnswers(action, all = false) {
        if (!this.session || !this.answerSnapshot) return action();
        const questions = this.session.state.questions;
        const indexes = all ? questions.map((_, i) => i) : [this.session.state.currentIndex];
        if (!indexes.some(i => questions[i] && !questions[i].gradingLoaded && this.answerSnapshot.items[i] && this.answerSnapshot.items[i].gradingRef)) return action();
        const expected = this.session, epoch = this.answerEpoch || 0;
        const active = () => this.session === expected && epoch === (this.answerEpoch || 0) && (!this.online || this.repository.getAuth(this.storage).userId === this.ownerId);
        return vault.hydrate(this.storage, this.answerSnapshot, questions, indexes, active).then(() => {
            if (!active()) return null;
            return action();
        });
    }
    reset() {
        if (!this.session) {
            return null;
        }
        return this.load(Object.assign({}, this.routeOptions, { sessionId: '', resume: '', selectionKey: '', seed: Date.now() }));
    }
    getShareMessage() {
        if (!this.session) {
            return {
                title: '题小搭练习',
                path: '/page/practice/index'
            };
        }
        return this.session.getShareMessage();
    }
    /**
     * 「重练错题」：把错题 id 存为自定义练习卷，交给答题页按 scope=custom 载入。
     */
    setResultFilter(filter) {
        if (!this.session) {
            return null;
        }
        return this.session.setResultFilter(filter);
    }
    setResultKeyword(keyword) {
        if (!this.session) {
            return null;
        }
        return this.session.setResultKeyword(keyword);
    }
    /** 打开题目详情：带上 sessionId，详情页才能同时显示「你的答案」 */
    createQuestionDetailCommand(questionId) {
        if (!questionId) {
            return null;
        }
        const sessionId = this.session ? this.session.meta.sessionId : '';
        const query = [`id=${encodeURIComponent(questionId)}`];
        if (sessionId) {
            query.push(`sessionId=${encodeURIComponent(sessionId)}`);
        }
        return {
            command: {
                type: 'navigate',
                url: `/page/question-detail/index?${query.join('&')}`
            }
        };
    }
    openFeedback() {
        if (!this.session)
            return null;
        const state = this.session.state;
        return require('../utils/feedback-entry.js').feedbackEntry(this.storage, 'question', state.questions[state.currentIndex]);
    }
    createRedoWrongCommand(questionIds) {
        const ids = (questionIds || []).filter(Boolean);
        if (!ids.length) {
            return null;
        }
        const route = getDefaultPracticeRoute(this.storage);
        return { command: { type: 'navigate', url: `/page/practice/index?bankId=${encodeURIComponent(this.routeOptions.bankId)}${this.routeOptions.bankIds ? '&bankIds=' + encodeURIComponent(this.routeOptions.bankIds) : ''}&${routeQuery(route)}&ids=${encodeURIComponent(ids.join(','))}${this.online ? '&selectionKind=WRONG' : ''}` } };
    }
    updateTimer(timerSeconds) {
        if (!this.session) {
            return null;
        }
        return this.session.updateTimer(timerSeconds);
    }
    tickElapsed() {
        if (!this.session || this.session.state.isCompleted) return null;
        return { data: { elapsedText: require('../models/practice-session.js').formatTimer(this.session.getElapsedSeconds()) } };
    }
    autoSubmit() {
        if (this.editingLocked)
            return null;
        if (!this.session) {
            return null;
        }
        return this.withAnswers(() => this.submitSavedAnswers(() => this.session.autoSubmit()), true);
    }
    selectOption(selectedIndex) {
        if (this.editingLocked || this.navigationPending)
            return null;
        if (!this.session) {
            return null;
        }
        return this.withAnswers(() => this.withPersistence(this.session.selectOption(selectedIndex)));
    }
    setAnswerText(text) {
        if (!this.session || this.editingLocked || this.navigationPending)
            return null;
        const result = this.session.setAnswerText(text);
        try {
            this.persistSession(true);
        }
        catch (error) {
            return Object.assign({}, result, { autoAdvance: false, submitOk: false, submitError: error.message, command: { type: 'toast', title: error.message || '本机保存失败' } });
        }
        return result;
    }
    setBlank(index, value) {
        if (!this.session || this.editingLocked || this.navigationPending)
            return null;
        const result = this.session.setBlank(index, value);
        try {
            this.persistSession(true);
        }
        catch (error) {
            return Object.assign({}, result, { autoAdvance: false, submitOk: false, submitError: error.message, command: { type: 'toast', title: error.message || '本机保存失败' } });
        }
        return result;
    }
    assessShortAnswer(value) {
        if (!this.session || this.editingLocked || this.navigationPending)
            return null;
        const result = this.session.assessShortAnswer(value);
        try {
            this.persistSession(true);
        }
        catch (error) {
            return Object.assign({}, result, { autoAdvance: false, submitOk: false, submitError: error.message, command: { type: 'toast', title: error.message || '本机保存失败' } });
        }
        return result;
    }
    async assessResult(questionId, value) {
        if ((this.trial || !this.online) && this.session && this.session.state.isCompleted) {
            if (!['CORRECT', 'WRONG'].includes(value))
                return null;
            const index = this.session.state.questions.findIndex(question => question.id === questionId && question.isShortAnswer);
            const answer = this.session.state.answers[index];
            if (!answer)
                return null;
            answer.selfAssessment = value;
            answer.isCorrect = false;
            this.session.finish();
            if (!this.trial)
                this.repository.saveSelfAssessment(this.storage, questionId, value);
            this.persistSession(true);
            return { data: this.session.getViewData() };
        }
        if (!this.online || !this.session || (!this.session.state.isCompleted && !this.readOnlyReview) || this.session.state.awaitingResult)
            return null;
        const snapshot = this.online.get(this.session.meta.sessionId);
        const item = snapshot.items.find(row => row.question.id === questionId);
        if (!item || item.question.type !== 'SHORT_ANSWER')
            return null;
        const result = await this.online.assess(snapshot.id, item.itemId, value);
        require('../repositories/remote-data-repository.js').invalidateLearning();
        const index = this.session.state.currentIndex;
        if (this.readOnlyReview) this.session.state.isViewMode = false;
        this.applyOfficialResult(result);
        if (this.readOnlyReview) {
            this.session.state.isViewMode = true;
            this.session.state.isCompleted = false;
            return this.session.showQuestionAtIndex(index);
        }
        return this.session.setResultFilter(this.session.state.resultFilter);
    }
    toggleFavoriteQuestion() {
        if (this.trial)
            return { command: { type: 'toast', title: '登录后可在正式练习中收藏题目' } };
        if (!this.session) {
            return null;
        }
        const result = this.session.toggleFavoriteQuestion();
        if (result && result.saveFavorite) {
            const payload = result.saveFavorite;
            const saved = payload.value ? this.repository.addQuestionFavorite(this.storage, payload.id) : this.repository.removeQuestionFavorite(this.storage, payload.id);
            if (saved && saved.then)
                return saved.then(() => {
                    if (this.online) {
                        const snapshot = this.online.get(this.session.meta.sessionId);
                        snapshot.favoriteQuestionIds = this.session.state.favoriteQuestionIds.slice();
                        this.online.put(snapshot.id, snapshot);
                    }
                    return { data: this.session.getViewData(), value: payload.value };
                }, error => {
                    const ids = this.session.state.favoriteQuestionIds.filter(id => id !== payload.id);
                    if (!payload.value)
                        ids.push(payload.id);
                    const current = this.session.getCurrentBaseQuestion();
                    this.session.updateState({ favoriteQuestionIds: ids, isCurrentQuestionFavorite: !!current && ids.indexOf(current.id) >= 0 });
                    throw error;
                });
        }
        return result;
    }
    /** 标记 / 取消标记：纯会话内状态，随 session 落盘，不额外写其它 storage */
    toggleMarkQuestion() {
        if (this.editingLocked)
            return null;
        if (!this.session) {
            return null;
        }
        return this.withPersistence(this.session.toggleMarkQuestion());
    }
    navigateQuestion(action) {
        if (this.navigationPending) return this.navigationPending;
        const result = this.withAnswers(() => this.navigateLoadedQuestion(action));
        if (!result || typeof result.then !== 'function') return result;
        const pending = Promise.resolve(result).finally(() => { if (this.navigationPending === pending) this.navigationPending = null; });
        this.navigationPending = pending; return pending;
    }
    navigateLoadedQuestion(action) {
        const previous = this.session.state.currentIndex;
        try {
            this.persistSession(true);
            const result = action();
            if (result && result.data && result.data.isCompleted)
                return this.withPersistence(result);
            this.persistSession(true);
            if (this.session.state.currentIndex === previous) return result;
            return this.withAnswers(() => { const shown = this.session.showQuestionAtIndex(this.session.state.currentIndex); shown.data = Object.assign({}, shown.data, this.contentUpdateData()); return shown; });
        }
        catch (error) {
            const result = this.session.showQuestionAtIndex(previous);
            return Object.assign({}, result, { command: { type: 'toast', title: error.message || '本机保存失败，请重试' } });
        }
    }
    goNext(bySwipe) {
        if (this.editingLocked)
            return null;
        if (!this.session) {
            return null;
        }
        if (!this.readOnlyReview && this.online && this.session.state.isViewMode && this.session.state.isLastQuestion) {
            return this.online.completeView(this.session).then(() => this.session.goNext())
                .catch(error => ({ command: { type: 'toast', title: error.message || '保存失败，请重试' } }));
        }
        return this.navigateQuestion(() => bySwipe && (this.session.preferences.swipeDraftAction === 'save' || !this.session.shouldConfirmCurrentAnswer()) && !this.session.state.isLastQuestion
            ? this.session.showQuestionAtIndex(this.session.state.currentIndex + 1) : this.session.goNext());
    }
    goPrev() {
        if (this.editingLocked)
            return null;
        if (!this.session) {
            return null;
        }
        return this.navigateQuestion(() => this.session.goPrev());
    }
    submit() {
        if (this.editingLocked)
            return null;
        if (!this.session) {
            return null;
        }
        return this.withAnswers(() => this.withPersistence(this.session.submit()), true);
    }
    forceSubmit() {
        if (this.editingLocked)
            return null;
        if (!this.session) {
            return null;
        }
        return this.withAnswers(() => this.submitSavedAnswers(() => this.session.forceSubmit()), true);
    }
    closeSubmitModal() {
        if (!this.session) {
            return null;
        }
        return this.session.closeSubmitModal();
    }
    openQuestionOverview() {
        if (!this.session) {
            return null;
        }
        return this.session.openQuestionOverview();
    }
    closeQuestionOverview() {
        if (!this.session) {
            return null;
        }
        return this.session.closeQuestionOverview();
    }
    jumpToQuestion(index) {
        if (this.editingLocked)
            return null;
        if (!this.session) {
            return null;
        }
        return this.navigateQuestion(() => this.session.jumpToQuestion(index));
    }
    /**
     * 会话落盘。背题模式不产生会话；游标未变则跳过写入。
     *
     * 游标包含完整草稿；多选勾选、文字和填空变化都进入持久态。
     */
    persistSession(force) {
        if (this.readOnlyReview) return;
        if (!this.session)
            return;
        if (this.trial) {
            trials.save(this.storage, this.session);
            return;
        }
        const id = this.session.meta.sessionId;
        const snapshot = this.online.get(id);
        if (this.session.state.isViewMode) {
            snapshot.localState = this.session.getPersistedState();
            this.online.put(id, snapshot);
            return;
        }
        if (snapshot && !snapshot.localResult && snapshot.status !== 'SUBMITTED' && !snapshot.finishIntent)
            this.online.save(this.session);
    }
    /** 页面退出（onHide / onUnload）时强制落盘，防止最后一步操作丢 */
    saveSessionNow() {
        if (!this.editingLocked)
            this.persistSession(true);
        if (this.online && this.session) {
            this.online.activeId = '';
            if (this.session.state.isCompleted)
                return Promise.resolve();
            return this.online.flush(this.session.meta.sessionId);
        }
    }
    /** 展示已保存的练习结果，保留当前筛选与阅读位置。 */
    applyOfficialResult(official) {
        const state = this.session.state;
        const resultFilter = state.resultFilter;
        const items = new Map(official.items.map(item => [item.question.id, item]));
        state.isCompleted = true;
        state.sessionStatus = SESSION_STATUS.SUBMITTED;
        if (typeof official.durationSeconds === 'number')
            this.session.frozenElapsedText = require('../models/practice-session.js').formatTimer(official.durationSeconds);
        state.answers = state.questions.map((question, index) => {
            const item = items.get(question.id);
            if (!item)
                return state.answers[index] || null;
            if (!item.answer)
                return null;
            return {
                questionId: question.id,
                selectedKeys: item.answer.optionKeys || (item.answer.value === null || item.answer.value === undefined ? [] : [String(item.answer.value)]),
                text: item.answer.text || '',
                blanks: item.answer.blanks || [],
                confirmed: item.confirmed,
                selfAssessment: item.selfAssessment || null,
                unscored: item.question.type === 'SHORT_ANSWER',
                isCorrect: item.question.type === 'SHORT_ANSWER' ? false : item.outcome === 'CORRECT'
            };
        });
        state.unansweredCount = this.session.getUnansweredIndexes(state.answers).length;
        this.session.finish();
        this.session.state.objectiveCount = official.objective.count;
        this.session.state.correctCount = official.objective.correct;
        this.session.state.score = typeof official.objective.score === 'number' ? official.objective.score : official.objective.count ? Math.round(official.objective.correct / official.objective.count * 100) : null;
        this.session.state.scoreText = this.session.state.score === null ? '已完成' : `${this.session.state.score} 分`;
        this.session.state.objectiveAccuracyText = official.objective.answered ? `${Math.round(official.objective.correct / official.objective.answered * 1000) / 10}%` : '—';
        this.session.setResultFilter(resultFilter);
    }
    resolveSubmitOutcome(result) {
        if (this.trial)
            return this.applySubmitOutcome(result, { ok: true, syncStatus: SYNC_STATUS.LOCAL_ONLY });
        if (this.online) {
            return this.online.finish(this.session).then((official) => {
                require('../repositories/remote-data-repository.js').invalidateLearning();
                if (!official) throw new Error('本次作答未能保存，请释放空间后重试');
                this.applyOfficialResult(official);
                return this.applySubmitOutcome(result, { ok: true, syncStatus: SYNC_STATUS.LOCAL_ONLY });
            }).catch(error => { this.session.state.isCompleted = false; this.session.state.sessionStatus = SESSION_STATUS.IN_PROGRESS; return { data: Object.assign(this.session.getViewData(), { isCompleted: false }), submitOk: false, submitError: error.message, command: { type: 'toast', title: error.message } }; });
        }
    }
    /** 提交结果落库：状态、落盘、副作用都在这一处，同步与异步两条路径共用 */
    applySubmitOutcome(result, outcome) {
        const safe = outcome || {};
        const statusResult = this.session.updateSyncStatus(safe.syncStatus || SYNC_STATUS.SYNCED);
        const merged = Object.assign({}, result, {
            data: statusResult.data,
            submitOk: safe.ok !== false,
            submitError: safe.ok === false ? safe.reason || '提交失败，请重试' : ''
        });
        this.persistSession(true);
        return merged;
    }
    /** 用户主动重试时查询原命令回执。 */
    retrySubmit() {
        if (!this.session)
            return null;
        if (this.trial)
            return this.resolveSubmitOutcome({ data: this.session.getViewData() });
        return this.online.queue.resume(this.session.meta.sessionId).then(() => this.resolveSubmitOutcome({ data: this.session.getViewData() }));
    }
    submitSavedAnswers(action) {
        const previous = Object.assign({}, this.session.state);
        try {
            this.persistSession(true);
            return this.withPersistence(action());
        }
        catch (error) {
            this.session.state = previous;
            this.session.submit();
            return { data: this.session.getViewData(), stopTimer: true, command: { type: 'toast', title: error.message || '本机保存失败，请重试交卷' } };
        }
    }
    withPersistence(result) {
        if (this.editingLocked)
            return { data: { editingLocked: true } };
        // 交卷这一步会走网关，返回 Promise；其余步骤仍是同步结果
        if (result && result.data && result.data.isCompleted) {
            this.persistSession(true);
            return this.resolveSubmitOutcome(result);
        }
        try {
            this.persistSession();
        }
        catch (error) {
            return Object.assign({}, result, { autoAdvance: false, submitOk: false, submitError: error.message, command: { type: 'toast', title: error.message || '本机保存失败' } });
        }
        return result;
    }
    /** 页面切到后台：暂停学习时长计时 */
    pauseStudy() {
        this.answerEpoch = (this.answerEpoch || 0) + 1;
        if (!this.session) {
            return null;
        }
        const result = this.session.pauseStudy();
        if (this.answerSnapshot) {
            vault.release(this.session.state.questions);
            this.session.state.resultItems = []; this.session.state.filteredResultItems = [];
            this.session.state.currentQuestion = null; this.session.state.currentExplanation = ''; this.session.state.currentCorrectAnswerText = '';
            return { ...result, data: { currentQuestion: null, currentExplanation: '', currentCorrectAnswerText: '', resultItems: [], filteredResultItems: [] } };
        }
        return result;
    }
    /** 页面回到前台：恢复学习时长计时 */
    resumeStudy() { return this.withAnswers(() => this.resumeLoadedStudy(), !!(this.session && this.session.state.isCompleted)); }
    resumeLoadedStudy() {
        if (!this.session) {
            return null;
        }
        const preferences = this.repository.getPreferences(this.storage);
        Object.assign(preferences, normalizePracticeOptions(this.session.meta.config, preferences));
        this.session.preferences = preferences;
        this.session.state.preferences = preferences;
        this.session.state.layoutRanks = require('../utils/practice-layout.js').ranks(preferences.moduleOrder);
        if (this.online && this.session)
            this.online.activeId = this.session.meta.sessionId;
        this.session.resumeStudy();
        if (this.session.state.isCompleted) {
            const filter = this.session.state.resultFilter; this.session.finish(); this.session.setResultFilter(filter);
        } else this.session.showQuestionAtIndex(this.session.state.currentIndex);
        return { data: this.session.getViewData() };
    }
}
module.exports = {
    PracticeViewModel
};
