const announcementReads = require('../repositories/announcement-reads.js');
const { preparePracticeRoute, routeQuery } = require('../repositories/practice-launch.js');
const practiceRepository = require('../repositories/practice-repository.js');
const { summarizeAnswers, summarizeOverallProgress } = require('../utils/practice-progress.js');
const { buildHomeContent } = require('../utils/home-content.js');
const { formatStudyDuration } = require('../utils/study-time.js');
const { buildExamCountdown, selectHomeExam } = require('../utils/exam-countdown.js');
const questionSearch = require('../utils/question-search.js');
/**
 * 「我的学习空间」四宫格。
 * 顺序固定为 最近练习 / 模拟考试 / 我的错题 / 我的收藏，与原型一致；
 * `key` 是点击分发的唯一依据，页面不写死中文。
 */
const STUDY_ENTRIES = [
    {
        key: 'recent',
        label: '练习记录',
        description: '接着上次的题库继续'
    },
    {
        key: 'mock',
        label: '模拟考试',
        description: '按题量与时长抽一套'
    },
    {
        key: 'wrong',
        label: '我的错题',
        description: '集中复习答错的题'
    },
    {
        key: 'favorite',
        label: '我的收藏',
        description: '收藏后随时回顾'
    }
];
function getInitialSubjectListViewData() {
    return {
        overall: null,
        lastPractice: null,
        recentSubjects: [],
        recentColumns: [[], []],
        recentPickerValue: [0, 0],
        recentSelectedSubjectId: '',
        recentSelectedBankId: '',
        recentSelectedName: '',
        recentHasHistory: false,
        recentLoading: true,
        recentError: '',
        newPracticeLoading: false,
        home: {
            greeting: '',
            dateText: '',
            advice: '',
            quote: '',
            // 封面图由 home-content 按时段给出（早/中/晚三张），初始值只是占位
            dayPart: 'noon',
            coverImage: '/assets/home/cover-noon.jpg',
            wrongCount: 0,
            studyTimeText: '尚未开始',
            tip: null
        },
        // 倒计时卡：未设置考试时 configured=false，卡片变成「去设置」引导
        exam: buildExamCountdown(null),
        // 四宫格上显示的计数 / 状态徽标
        entries: STUDY_ENTRIES.map((item) => Object.assign({}, item, { badge: '', disabled: false })),
        announcements: [],
        announcementScrollTop: 0,
        pinnedAnnouncement: null,
        selectedAnnouncement: null,
        hasAnnouncements: false,
        hasUnreadAnnouncements: false,
        announcementSheetVisible: false,
        // 题目搜索
        searchVisible: false,
        searchKeyword: '',
        searchResults: [],
        searchLoading: false,
        searchSearched: false,
        searchResultCount: 0,
        searchHasMore: false,
        // 搜索面板空态文案：题库总数用于「在全部 N 道题里查」
        searchTotalText: '',
        routeLoadingVisible: false,
        routeLoadingTitle: '正在打开',
        routeLoadingDescription: ''
    };
}
class SubjectListViewModel {
    constructor(options) {
        const normalizedOptions = options || {};
        this.repository = normalizedOptions.repository || practiceRepository;
        this.storage = normalizedOptions.storage || null;
        this.searchPage = 0;
        this.searchResults = [];
        this.searchText = '';
    }
    refreshRemote(options) {
        this.homeRefreshError = '';
        return this.repository.refreshRemote(this.storage, 'home', options).then(results => {
            const failed = Array.isArray(results) && results.find(item => item.status === 'rejected');
            this.homeRefreshError = failed ? failed.reason.message || '部分内容读取失败' : '';
            return { data: this.projectRemote() };
        }).catch(error => { this.homeRefreshError = error.message; return { data: this.projectRemote() }; });
    }
    projectRemote() {
        const data = this.load().data;
        const result = {};
        ['overall', 'home', 'exam', 'entries', 'announcements', 'pinnedAnnouncement', 'hasAnnouncements', 'hasUnreadAnnouncements', 'lastPractice', 'searchTotalText'].forEach(key => { result[key] = data[key]; });
        if (this.repository.getRemoteResourceState) {
            const overview = this.repository.getRemoteResourceState('overview');
            result.overviewLoading = overview.status === 'loading' && !overview.data;
            result.overviewError = overview.error;
            result.homeRefreshError = this.homeRefreshError || '';
        }
        return result;
    }
    static getInitialData() {
        return getInitialSubjectListViewData();
    }
    load() {
        const subjects = this.repository.getSubjectSummaries();
        const progress = this.repository.getProgress(this.storage);
        const overallStats = summarizeOverallProgress(progress, subjects);
        const overview = this.repository.getRemoteOverview(this.storage);
        if (overview) {
            const objectiveAnswered = overview.objectiveAnsweredCount;
            const accuracy = objectiveAnswered ? Math.round(overview.objectiveCorrectCount / objectiveAnswered * 100) : null;
            Object.assign(overallStats, { answered: overview.answerAttemptCount, correct: overview.objectiveCorrectCount, total: overview.totalCount,
                isCumulative: true, answeredText: `累计 ${overview.answerAttemptCount} 题次`, hasProgress: overview.answerAttemptCount > 0,
                accuracy,
                accuracyText: accuracy === null ? '—' : `${accuracy}%`,
                progressPercent: overview.totalCount ? Math.min(100, Math.round(overview.distinctQuestionCount / overview.totalCount * 100)) : 0 });
        }
        const wrongSummary = this.getWrongBookSummary();
        const studyTime = this.getStudyTime();
        const preferences = this.getPreferences();
        // 首页文案与统计口径共用同一份 summary，
        // 避免出现「横幅说还有 3 道错题、卡片写 5 道」这类前后不一致
        const summary = {
            answered: overallStats.answered,
            total: overallStats.total,
            accuracyText: overallStats.accuracyText,
            progressPercent: overallStats.progressPercent,
            coverageKnown: !overview,
            pendingWrong: wrongSummary.pending,
            masteredWrong: wrongSummary.mastered,
            studySeconds: studyTime.totalSeconds,
            studySessionCount: studyTime.sessionCount
        };
        const lastPractice = this.buildLastPractice(progress);
        const announcements = this.repository.getRemoteAnnouncements ? this.repository.getRemoteAnnouncements(this.storage).map(item => Object.assign({}, item, { dateText: (item.publishAt || item.updatedAt || '').slice(0, 10) })) : [];
        const preview = this.repository.getRemoteAnnouncementPreview ? this.repository.getRemoteAnnouncementPreview(this.storage) : announcements[0];
        return {
            data: Object.assign(getInitialSubjectListViewData(), {
                overall: Object.assign({}, overallStats, {
                    subjectCount: overview ? overview.subjectCount : subjects.length,
                    bankCount: overview ? overview.bankCount : subjects.reduce((total, subject) => total + (subject.bankCount || 0), 0)
                }),
                home: Object.assign({}, buildHomeContent(summary), {
                    wrongCount: wrongSummary.pending,
                    studyTimeText: formatStudyDuration(studyTime.totalSeconds)
                }),
                exam: selectHomeExam(preferences.examCountdowns),
                entries: this.buildEntries(lastPractice),
                announcements,
                hasUnreadAnnouncements: this.hasUnreadAnnouncements(announcements),
                pinnedAnnouncement: preview && preview.pinned ? preview : null,
                hasAnnouncements: this.repository.getRemoteAnnouncementTotal ? this.repository.getRemoteAnnouncementTotal(this.storage) > 0 : announcements.length > 0,
                searchTotalText: overallStats.total > 0 ? `在全部 ${overallStats.total} 道题里查题干与选项` : '输入关键词搜索已发布的题目',
                lastPractice
            })
        };
    }
    /** 读偏好失败时退回默认值：首页是 tabBar 主页面，不能因为一个字段崩掉 */
    getPreferences() {
        try {
            return this.repository.getPreferences(this.storage) || {};
        }
        catch (error) {
            return {};
        }
    }
    /**
     * 四宫格徽标。
     * 有数字的显示数字（错题 / 收藏 / 最近练习的已答题数），
     * 没有的留空——空徽标比写「0」更克制，不会让四项看起来都"空"。
     */
    buildEntries(lastPractice) {
        const wrongCount = this.getWrongBookSummary().pending;
        const favoriteCount = this.getFavoriteCount();
        const recentAnswered = lastPractice && lastPractice.stats ? lastPractice.stats.answered : 0;
        return STUDY_ENTRIES.map((item) => {
            if (item.key === 'wrong') {
                return Object.assign({}, item, { badge: wrongCount > 0 ? String(wrongCount) : '' });
            }
            if (item.key === 'favorite') {
                return Object.assign({}, item, { badge: favoriteCount > 0 ? String(favoriteCount) : '' });
            }
            if (item.key === 'recent') {
                return Object.assign({}, item, { badge: recentAnswered > 0 ? String(recentAnswered) : '' });
            }
            return Object.assign({}, item, { badge: '' });
        });
    }
    getFavoriteCount() {
        return (this.repository.getRemoteOverview(this.storage) || {}).favoriteCount || 0;
    }
    /** 错题本汇总；仓储未提供对应方法时退化为空，保证首页仍能渲染 */
    getWrongBookSummary() {
        const summary = this.repository.getRemoteOverview(this.storage) || {};
        return { pending: summary.wrongBookCount || 0, mastered: summary.masteredCount || 0, total: (summary.wrongBookCount || 0) + (summary.masteredCount || 0) };
    }
    getStudyTime() {
        if (!this.repository.getStudyTime) {
            return { totalSeconds: 0, sessionCount: 0, updatedAt: 0 };
        }
        return this.repository.getStudyTime(this.storage);
    }
    /**
     * 找出「继续练习」的入口。
     *
     * 优先用未完成的 PracticeSession：它才是真正的"半场练习"，
     * 能接着原来的题序和答案往下做。没有未完成会话时，
     * 才退回"最近做过哪个题库"（只有进度统计，进入即新开一轮）。
     */
    buildLastPractice(progress) {
        const resumed = this.buildResumablePractice();
        if (resumed) {
            return resumed;
        }
        return this.buildLatestProgressPractice(progress);
    }
    buildResumablePractice() {
        const recent = this.repository.getResumableSession(this.storage);
        if (recent) {
            const config = recent.config || {};
            const meta = this.repository.getScopeMeta(config.bankId);
            return { resumed: true, scopeKey: config.bankId || '', title: config.title || (meta && meta.title) || '进行中的练习', description: meta ? meta.description : '', url: `/page/practice/index?sessionId=${encodeURIComponent(recent.sessionId)}`, metaText: this.repository.getAuth(this.storage).loggedIn ? '正式练习' : '本机试答' };
        }
        return null;
    }
    /** 没有未完成会话时的兜底：最近做过哪个题库 */
    buildLatestProgressPractice(progress) {
        const scopeKeys = Object.keys(progress || {});
        if (!scopeKeys.length) {
            return null;
        }
        const latestScopeKey = scopeKeys.reduce((latest, scopeKey) => {
            if (!latest) {
                return scopeKey;
            }
            const currentUpdatedAt = (progress[scopeKey] && progress[scopeKey].updatedAt) || 0;
            const latestUpdatedAt = (progress[latest] && progress[latest].updatedAt) || 0;
            return currentUpdatedAt > latestUpdatedAt ? scopeKey : latest;
        }, '');
        const meta = this.repository.getScopeMeta(latestScopeKey);
        if (!meta) {
            return null;
        }
        const entry = progress[latestScopeKey] || { answers: {}, total: 0 };
        const stats = summarizeAnswers(entry.answers, entry.total);
        return Object.assign({}, meta, {
            stats,
            metaText: `已做 ${stats.answered} 题 · 正确率 ${stats.accuracyText}`
        });
    }
    openPractice(url, title) {
        if (!url) {
            return null;
        }
        return {
            command: {
                type: 'openRouteWithLoading',
                payload: {
                    url,
                    title: '正在开始练习',
                    description: title || ''
                }
            }
        };
    }
    async loadRecentChoices(options) {
        const identity = this.repository.getAuth(this.storage);
        await this.repository.refreshRemote(this.storage, 'recent', options);
        const sameIdentity = () => {
            const current = this.repository.getAuth(this.storage);
            return current.userId === identity.userId && current.token === identity.token && current.loggedIn === identity.loggedIn;
        };
        if (!sameIdentity()) return null;
        const records = this.repository.getRemoteRecent(this.storage).filter(item => item.questionBankId && item.id && ['IN_PROGRESS', 'SUBMITTED'].includes(item.status));
        const bankIds = [...new Set(records.map(item => item.questionBankId))];
        const missing = bankIds.filter(id => { const meta = this.repository.getScopeMeta(id); return !meta || !meta.bankId; });
        const loaded = await Promise.allSettled(missing.map(id => this.repository.loadRemoteBank(this.storage, id)));
        if (!sameIdentity()) return null;
        const failure = loaded.find(result => result.status === 'rejected' && (!result.reason || result.reason.statusCode !== 404));
        if (failure) throw failure.reason || new Error('题库读取失败，请重试');
        const subjectIds = [...new Set(bankIds.map(id => this.repository.getScopeMeta(id)).filter(meta => meta && meta.bankId && !meta.description).map(meta => meta.subjectId))];
        await Promise.all(subjectIds.map(id => this.repository.loadRemoteSubject(this.storage, id)));
        if (!sameIdentity()) return null;
        const subjects = [];
        bankIds.forEach(id => {
            const meta = this.repository.getScopeMeta(id);
            if (!meta || !meta.bankId || !meta.subjectId || !meta.description) return;
            let subject = subjects.find(item => item.id === meta.subjectId);
            if (!subject) { subject = { id: meta.subjectId, name: meta.description, banks: [] }; subjects.push(subject); }
            subject.banks.push({ id: meta.bankId, name: meta.title });
        });
        return { subjects, hasHistory: records.length > 0 };
    }
    async openNewPractice(choice) {
        if (!choice) return this.openBank();
        try {
            const result = await preparePracticeRoute(this.storage, this.repository, { questionBankId: choice.id, selectionKind: 'NORMAL', collectionChip: 'all' });
            return this.openPractice('/page/practice/index?' + routeQuery(result.route), choice.name);
        } catch (error) { return { command: { type: 'toast', title: error.message } }; }
    }
    /** 学习数据卡右上角「详情」→ 统计 tab */
    openStats() {
        return {
            command: {
                type: 'switchTab',
                url: '/page/stats/index'
            }
        };
    }
    /** 「去刷题」→ 题库 tab。不带 subjectId，保留题库页当前选中的科目 */
    openBank() {
        return {
            command: {
                type: 'switchTab',
                url: '/page/bank-detail/index'
            }
        };
    }
    /** 「待复习错题」格 → 错题本 */
    openWrongBook() {
        return this.openPersonalPage('/page/wrong-book/index?tab=wrong');
    }
    openPersonalPage(url) {
        return {
            command: {
                type: 'openRouteWithLoading',
                payload: {
                    url: this.repository.getAuth(this.storage).loggedIn ? url : '/page/login/index'
                }
            }
        };
    }
    // ---------- 四宫格 ----------
    /** 四宫格分发：只在 ViewModel 里决定去向，页面只按 key 调一次 */
    openEntry(key) {
        if (key === 'wrong') {
            return this.openWrongBook();
        }
        if (key === 'favorite') {
            return this.openPersonalPage('/page/wrong-book/index?tab=favorite');
        }
        if (key === 'recent') {
            return this.openRecent();
        }
        if (key === 'mock') {
            return this.openMock();
        }
        return null;
    }
    /** 最近练习同时提供续答和历史成绩入口。 */
    openRecent() {
        return this.openPersonalPage('/page/practice-records/index');
    }

    openMock() {
        return { command: { type: 'switchTab', url: '/page/bank-detail/index', target: { intent: 'test' } } };
    }
    // ---------- 公告 ----------
    hasUnreadAnnouncements(items) {
        const known = this.repository.getRemoteAnnouncementIndex ? this.repository.getRemoteAnnouncementIndex(this.storage) : [];
        const versions = new Map(known.map(item => [item.id, item]));
        items.forEach(item => versions.set(item.id, item));
        return announcementReads.hasUnread(this.storage, Array.from(versions.values()));
    }
    markAnnouncementRead(item) {
        announcementReads.markRead(this.storage, item);
        return { data: { hasUnreadAnnouncements: this.hasUnreadAnnouncements(this.repository.getRemoteAnnouncements(this.storage)) } };
    }
    openAnnouncement() {
        return {
            data: {
                announcementSheetVisible: true
            }
        };
    }
    loadAnnouncements(page, force) {
        return this.repository.refreshRemote(this.storage, 'announcements', { page: page || 1, force: !!force }).then(() => ({ data: {
                announcements: this.repository.getRemoteAnnouncements(this.storage).map(item => Object.assign({}, item, { dateText: (item.publishAt || item.updatedAt || '').slice(0, 10) })),
                announcementPage: page || 1,
                announcementHasMore: this.repository.getRemoteAnnouncements(this.storage).length < this.repository.getRemoteAnnouncementTotal(this.storage)
            } }));
    }
    closeAnnouncement() {
        return {
            data: {
                announcementSheetVisible: false
            }
        };
    }
    // ---------- 题目搜索 ----------
    openSearch() {
        return {
            data: {
                searchVisible: true
            }
        };
    }
    closeSearch() {
        this.searchText = '';
        this.searchRequestRevision = (this.searchRequestRevision || 0) + 1;
        return {
            data: {
                searchVisible: false,
                searchHasMore: false,
                searchLoading: false,
                searchKeyword: '',
                searchResults: [],
                searchSearched: false,
                searchResultCount: 0
            }
        };
    }
    /** 按关键词分页搜索，并忽略已过期请求。 */
    searchQuestions(keyword) {
        const text = questionSearch.normalizeKeyword(keyword);
        return this.searchRemote(text, 1);
    }
    searchRemote(text, page) {
        const revision = (this.searchRequestRevision || 0) + 1;
        this.searchRequestRevision = revision;
        if (!text) {
            this.searchText = '';
            this.searchResults = [];
            this.searchPage = 0;
            return { data: { searchKeyword: '', searchResults: [], searchLoading: false, searchSearched: false, searchResultCount: 0, searchHasMore: false } };
        }
        if (page === 1) {
            this.searchText = text;
            this.searchResults = [];
        }
        return this.repository.searchRemoteQuestions(this.storage, text, page).then((result) => {
            if (text !== this.searchText || revision !== this.searchRequestRevision)
                return null;
            this.searchResults = page === 1 ? result.items : this.searchResults.concat(result.items);
            this.searchPage = page;
            return { data: { searchKeyword: text, searchResults: this.searchResults, searchLoading: false, searchSearched: true, searchResultCount: result.total, searchHasMore: this.searchResults.length < result.total } };
        });
    }
    loadMoreSearch() { return this.searchRemote(this.searchText, this.searchPage + 1); }
    openSearchResult(questionId) {
        if (!questionId) {
            return null;
        }
        return {
            command: {
                type: 'openRouteWithLoading',
                payload: {
                    url: `/page/question-detail/index?id=${encodeURIComponent(questionId)}`,
                    title: '正在打开题目',
                    description: '读取题目与解析'
                }
            }
        };
    }
    /** 登录后管理考试倒计时。 */
    openExamSettings() {
        return this.openPersonalPage('/page/exam-countdown/index');
    }
    getShareMessage() {
        return {
            title: '题小搭题库',
            path: '/page/subject-list/index'
        };
    }
}
module.exports = {
    STUDY_ENTRIES,
    SubjectListViewModel
};
