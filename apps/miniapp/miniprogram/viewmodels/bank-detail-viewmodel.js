const practiceRepository = require('../repositories/practice-repository.js');
const { summarizeBankProgress, summarizeSubjectProgress } = require('../utils/practice-progress.js');
const CN_NUMBERS = [
    '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'
];
const MAX_KEYWORD_LENGTH = 20;
const { DEFAULT_DURATION_MINUTES, MODE_OPTIONS, ORDER_OPTIONS, DURATION_OPTIONS, DEFAULT_SHEET, resolveModeValue, resolveOrderValue, resolveRouteMode, buildPracticeConfig } = require('../models/bank-practice-config.js');
function getInitialBankDetailViewData() {
    return {
        subjectId: '',
        subject: null,
        subjects: [],
        stats: null,
        // 左栏：'recent' = 最近在刷，'subject' = 某个科目
        railMode: 'subject',
        recentSubjectId: '',
        recentSubjectName: '',
        // 右栏章节列表（按当前面板的科目）
        rows: [],
        chapterGroups: [],
        showBankTitles: false,
        hiddenRowCount: 0,
        listEmptyText: '这个科目还没有章节',
        // 搜索
        searchKeyword: '',
        searchActive: false,
        searchResults: [],
        searchEmptyText: '',
        // 筛选：只看没刷完的章节
        filterUnfinished: false,
        filterEnabled: false,
        // 答题配置抽屉
        configSheetVisible: false,
        configTitle: '答题配置',
        configSubtitle: '',
        configTargetName: '',
        sheetMode: DEFAULT_SHEET.mode,
        sheetOrder: DEFAULT_SHEET.order,
        sheetTimed: DEFAULT_SHEET.timed,
        sheetDuration: DEFAULT_SHEET.duration,
        sheetOnlyWrong: DEFAULT_SHEET.onlyWrong,
        sheetWrongCount: 0,
        sheetBanks: [],
        sheetAllBanksSelected: false,
        sheetSomeBanksSelected: false,
        sheetStartDisabled: false,
        sheetOrderDisabled: false,
        modeOptions: MODE_OPTIONS,
        orderOptions: ORDER_OPTIONS,
        durationOptions: DURATION_OPTIONS,
        sheetStartText: '开始答题',
        mode: 'order',
        isViewMode: false,
        selectedDuration: DEFAULT_DURATION_MINUTES,
        routeLoadingVisible: false,
        routeLoadingTitle: '正在开始练习',
        routeLoadingDescription: ''
    };
}
function chapterTitle(index, name) {
    const text = String(name === undefined || name === null ? '' : name).trim();
    // 有些题库名本身就带序号（「第一单元」），再套一层就成了「第一章：第一单元」
    if (/^第[一二三四五六七八九十百\d]+[章单元节讲]/.test(text)) {
        return text;
    }
    const cn = CN_NUMBERS[index] || String(index + 1);
    return `第${cn}章：${text}`;
}
function chapterMetaText(stats, hasProgress) {
    if (!stats) {
        return '';
    }
    return hasProgress ? `${stats.answered}/${stats.total}` : stats.totalText;
}
class BankDetailViewModel {
    constructor(options) {
        const normalizedOptions = options || {};
        this.repository = normalizedOptions.repository || practiceRepository;
        this.storage = normalizedOptions.storage || null;
        this.railMode = 'subject';
        this.filterUnfinished = false;
        this.sheet = Object.assign({}, DEFAULT_SHEET);
        this.sheetTarget = null;
        // 已加载的目录条目按科目建立索引。
        this.bankIndex = null;
    }
    refreshRemote(subjectId, options) {
        if (subjectId && subjectId !== this.currentSubjectId)
            this.remotePage = 1;
        if (subjectId)
            this.currentSubjectId = subjectId;
        if (options && options.force) {
            this.remotePage = 1;
            this.remoteSubjectPage = 1;
        }
        return this.repository.refreshRemote(this.storage, 'catalog', Object.assign({}, options, { subjectId: this.currentSubjectId, page: this.remotePage || 1 }))
            .then(async () => {
            if (this.repository.loadRemoteChapters) {
                const subjects = this.repository.getSubjectSummaries();
                const id = subjects.some(subject => subject.id === this.currentSubjectId) ? this.currentSubjectId : (subjects[0] || {}).id;
                const page = this.repository.getRemoteCatalogPage({ subjectId: id, page: this.remotePage || 1 }).data;
                await Promise.allSettled((page && page.items || []).map(bank => this.repository.loadRemoteChapters(this.storage, bank.id, options)));
            }
            return { data: this.projectRemote() };
        }).catch(() => ({ data: this.projectRemote() }));
    }
    projectRemote() {
        const subjects = this.repository.getSubjectSummaries();
        const id = subjects.some(subject => subject.id === this.currentSubjectId) ? this.currentSubjectId : (subjects[0] || {}).id;
        const detail = this.repository.getSubjectDetail(id);
        const current = this.repository.getRemoteCatalogPage({ subjectId: id, page: this.remotePage || 1 });
        const ids = new Set();
        for (let page = 1; page <= (this.remotePage || 1); page += 1) {
            const cached = this.repository.getRemoteCatalogPage({ subjectId: id, page }).data;
            (cached && cached.items || []).forEach(bank => ids.add(bank.id));
        }
        const data = detail ? this.buildViewData(subjects, Object.assign({}, detail, { banks: detail.banks.filter(bank => ids.has(bank.id)) })) : { subject: null, subjects: [] };
        ['searchKeyword', 'searchActive', 'searchResults', 'searchEmptyText', 'configSheetVisible'].forEach(key => delete data[key]);
        const subjectState = this.repository.getRemoteSubjectPage(this.remoteSubjectPage || 1);
        const subjectPage = subjectState.data;
        const chapterStates = Array.from(ids).map(bankId => this.repository.getRemoteResourceState('chapters:' + bankId));
        data.loggedIn = !!this.repository.getAuth(this.storage).token;
        Object.assign(data, { catalogLoading: ((current.status === 'loading' || subjectState.status === 'loading') && !ids.size) || (!data.rows?.length && chapterStates.some(state => state.status === 'idle' || state.status === 'loading')),
            catalogError: current.error || subjectState.error || (chapterStates.find(state => state.error) || {}).error || '',
            catalogHasMore: !!current.data && (this.remotePage || 1) * 20 < current.data.total,
            subjectsHasMore: !!subjectPage && (this.remoteSubjectPage || 1) * 20 < subjectPage.total });
        return data;
    }
    loadMoreBanks() {
        if (this.loadingMoreBanks)
            return this.loadingMoreBanks;
        const current = this.repository.getRemoteCatalogPage({ subjectId: this.currentSubjectId, page: this.remotePage || 1 });
        if (!current.error)
            this.remotePage = (this.remotePage || 1) + 1;
        this.loadingMoreBanks = this.refreshRemote(this.currentSubjectId).finally(() => { this.loadingMoreBanks = null; });
        return this.loadingMoreBanks;
    }
    changeProfile() {
        return { command: { type: 'navigate', url: this.repository.getAuth(this.storage).token ? '/page/account/index' : '/page/login/index' } };
    }
    requestCourse() {
        return require('../utils/feedback-entry.js').feedbackEntry(this.storage, 'course');
    }
    loadMoreSubjects() {
        if (this.loadingMoreSubjects)
            return this.loadingMoreSubjects;
        const current = this.repository.getRemoteSubjectPage(this.remoteSubjectPage || 1);
        if (!current.error)
            this.remoteSubjectPage = (this.remoteSubjectPage || 1) + 1;
        this.loadingMoreSubjects = this.repository.loadRemoteSubjects(this.storage, { page: this.remoteSubjectPage })
            .then(() => ({ data: this.projectRemote() })).catch(() => ({ data: this.projectRemote() }))
            .finally(() => { this.loadingMoreSubjects = null; });
        return this.loadingMoreSubjects;
    }
    static getInitialData() {
        return getInitialBankDetailViewData();
    }
    load(subjectId) {
        const subjects = this.repository.getSubjectSummaries();
        const firstSubjectId = subjects.length ? subjects[0].id : '';
        // 题库是 tabBar 页面，参数失效时不能靠「返回」兜底，
        // 因此回落到第一个科目，避免停在一个空工作台。
        const detail = this.repository.getSubjectDetail(subjectId || firstSubjectId) ||
            this.repository.getSubjectDetail(firstSubjectId);
        if (!detail) {
            return { data: { catalogLoading: true } };
        }
        this.railMode = 'subject';
        this.sheet = Object.assign({}, DEFAULT_SHEET);
        this.sheetTarget = null;
        return {
            data: this.buildViewData(subjects, detail)
        };
    }
    switchSubject(subjectId) {
        if (this.currentSubjectId !== subjectId)
            this.remotePage = 1;
        const detail = this.repository.getSubjectDetail(subjectId);
        if (!detail) {
            return null;
        }
        this.railMode = 'subject';
        return {
            data: this.buildViewData(this.repository.getSubjectSummaries(), detail)
        };
    }
    /**
     * 「最近在刷」：跳到上次练习的科目。
     *
     * 不额外存「最近浏览」，只认真实练习记录（进度表里 updatedAt 最新的那条），
     * 这样它不会变成一个点了没反应、或者和真实学习状态不符的假入口。
     */
    enterRecent(loaded) {
        if (!loaded) {
            return this.repository.refreshRemote(this.storage, 'recent').then(async () => {
                const recent = this.repository.getRemoteRecent(this.storage)[0];
                if (!recent)
                    return { command: { type: 'toast', title: '还没有练习记录' } };
                const bank = await this.repository.loadRemoteBank(this.storage, recent.questionBankId);
                await this.refreshRemote(bank.subjectId);
                this.railMode = 'recent';
                return { data: this.projectRemote() };
            });
        }
        const subjects = this.repository.getSubjectSummaries();
        const recent = this.resolveRecentSubject(subjects);
        const detail = this.repository.getSubjectDetail(recent ? recent.subjectId : '') ||
            this.repository.getSubjectDetail(subjects.length ? subjects[0].id : '');
        if (!detail) {
            return null;
        }
        this.railMode = 'recent';
        return {
            data: this.buildViewData(subjects, detail)
        };
    }
    /** 回到当前所在面板（不切换 rail 语义），页面 onShow 刷新用 */
    refresh(state) {
        const current = state || {};
        if (current.railMode === 'recent') {
            return this.enterRecent();
        }
        return this.switchSubject(current.subjectId) || this.load(current.subjectId);
    }
    resolveRecentSubject(subjects) {
        const recent = this.repository.getRemoteRecent(this.storage)[0];
        const subject = recent && subjects.find(item => item.banks.some(bank => bank.id === recent.questionBankId));
        return subject ? { subjectId: subject.id, scopeKey: recent.questionBankId } : null;
    }
    safeProgress() {
        try {
            return this.repository.getProgress(this.storage) || {};
        }
        catch (error) {
            return {};
        }
    }
    /**
     * 组装左栏、统计卡、章节列表。
     */
    buildViewData(subjects, detail) {
        this.currentSubjectId = detail.id;
        const progress = this.safeProgress();
        const subjectStats = summarizeSubjectProgress(progress, detail);
        const allRows = (detail.banks || []).flatMap((bank, index) => {
            if (this.repository.getRemoteChapters)
                return this.buildChapterRows(detail, bank);
            const bankStats = summarizeBankProgress(progress, bank);
            const hasProgress = !!bankStats && bankStats.hasProgress;
            return [{
                    id: bank.id,
                    bankId: bank.id,
                    subjectId: detail.id,
                    index,
                    title: bank.name,
                    unitText: bank.unitText || `单元 ${index + 1}`,
                    metaText: chapterMetaText(bankStats, hasProgress),
                    questionCount: bank.questionCount || 0,
                    answered: bankStats ? bankStats.answered : 0,
                    progressPercent: bankStats ? bankStats.progressPercent : 0,
                    hasProgress,
                    isComplete: !!bankStats && bankStats.progressPercent >= 100
                }];
        });
        const rows = this.filterRows(allRows);
        const recent = this.resolveRecentSubject(subjects);
        // 筛选切换只重算列表，不重新取卷：统计卡与左栏都不受影响
        this.allRows = allRows;
        this.bankIndex = this.buildBankIndex(subjects);
        return Object.assign({
            subjectId: detail.id,
            subject: this.buildSubjectView(detail),
            stats: subjectStats,
            subjects: subjects.map((subject) => ({
                id: subject.id,
                name: subject.name,
                theme: subject.theme,
                active: this.railMode === 'subject' && subject.id === detail.id,
                recentActive: this.railMode === 'recent'
            })),
            railMode: this.railMode,
            recentSubjectId: recent ? recent.subjectId : '',
            recentSubjectName: recent ? this.subjectNameOf(subjects, recent.subjectId) : '',
            rows,
            chapterGroups: this.groupChapterRows(rows),
            showBankTitles: (detail.bankCount > 1 || detail.banks.length > 1),
            hiddenRowCount: allRows.length - rows.length,
            listEmptyText: this.resolveListEmptyText(allRows.length, rows.length),
            filterEnabled: allRows.length > 0,
            // 搜索面板与抽屉由用户操作驱动，重新加载时一律回到关闭态
            searchKeyword: '',
            searchActive: false,
            searchResults: [],
            searchEmptyText: '',
            configSheetVisible: false
        }, this.buildSheetData());
    }
    buildChapterRows(detail, bank) {
        const chapters = this.repository.getRemoteChapters(this.storage, bank.id);
        if (!chapters)
            return [];
        const choices = chapters.filter(chapter => chapter.questionCount > 0);
        if (!chapters.length || chapters.reduce((count, chapter) => count + chapter.questionCount, 0) < bank.questionCount) {
            choices.push({ id: '', name: '全部题目', questionCount: bank.questionCount, progress: bank.progress });
        }
        return choices.map(chapter => {
            const stats = summarizeBankProgress({}, chapter);
            return {
                id: bank.id + ':' + chapter.id, bankId: bank.id, chapterId: chapter.id, subjectId: detail.id,
                title: chapter.name,
                questionCount: chapter.questionCount, metaText: chapterMetaText(stats, stats.hasProgress),
                answered: stats.answered, progressPercent: stats.progressPercent, hasProgress: stats.hasProgress,
                isComplete: chapter.questionCount > 0 && stats.answered >= chapter.questionCount
            };
        });
    }
    groupChapterRows(rows) {
        const detail = this.repository.getSubjectDetail(this.currentSubjectId);
        return (detail && detail.banks || []).map(bank => ({ id: bank.id, name: bank.name, rows: rows.filter(row => row.bankId === bank.id) })).filter(group => group.rows.length);
    }
    /**
     * 筛选只影响「列表显示」，不影响统计卡 —— 统计永远按整科算，
     * 否则打开筛选后数字会变，看起来像进度丢了。
     */
    filterRows(allRows) {
        const rows = Array.isArray(allRows) ? allRows : [];
        if (!this.filterUnfinished) {
            return rows;
        }
        return rows.filter((row) => !row.isComplete);
    }
    resolveListEmptyText(totalCount, visibleCount) {
        if (!totalCount) {
            return '这个科目还没有章节';
        }
        if (!visibleCount && this.filterUnfinished) {
            return '所有章节都刷完了，关掉筛选看看';
        }
        return '没有符合条件的章节';
    }
    buildSubjectView(detail) {
        return {
            id: detail.id,
            name: detail.name,
            theme: detail.theme,
            description: detail.description,
            bankCount: detail.bankCount,
            questionCount: detail.questionCount
        };
    }
    subjectNameOf(subjects, subjectId) {
        const matched = (subjects || []).find((subject) => subject.id === subjectId);
        return matched ? matched.name : '';
    }
    /** 搜索索引：跨科目搜章节名 / 科目名，命中后能直接跳到那一章 */
    buildBankIndex(subjects) {
        const index = [];
        (subjects || []).forEach((subject) => {
            const detail = this.repository.getSubjectDetail(subject.id);
            if (!detail) {
                return;
            }
            (detail.banks || []).forEach((bank, position) => {
                index.push({
                    id: bank.id,
                    bankId: bank.id,
                    subjectId: detail.id,
                    subjectName: detail.name,
                    title: bank.name,
                    chapterTitle: chapterTitle(position, bank.name),
                    metaText: bank.questionText || `${bank.questionCount} 题`,
                    progressPercent: bank.progressPercent || 0
                });
            });
        });
        return index;
    }
    updateSearch(keyword, nextPage) {
        const text = String(keyword === undefined || keyword === null ? '' : keyword)
            .trim()
            .slice(0, MAX_KEYWORD_LENGTH);
        if (text) {
            this.remoteSearchText = text;
            const pageNumber = nextPage || 1;
            return this.repository.loadRemoteBanks(this.storage, { keyword: text, page: pageNumber }).then(async () => {
                if (this.remoteSearchText !== text)
                    return null;
                const page = this.repository.getRemoteCatalogPage({ keyword: text, page: pageNumber }).data;
                this.remoteSearchPage = pageNumber;
                const groups = await Promise.all((page && page.items || []).map(async (bank) => {
                    await this.repository.loadRemoteChapters(this.storage, bank.id);
                    return this.buildChapterRows({ id: bank.subjectId, banks: [bank] }, Object.assign({}, bank, { questionCount: bank.activeQuestionCount }))
                        .filter(row => `${bank.name}${row.title}`.toLowerCase().includes(text.toLowerCase()))
                        .map(row => Object.assign({}, row, { subjectName: bank.subjectName, bankName: bank.name, chapterTitle: row.title }));
                }));
                if (this.remoteSearchText !== text)
                    return null;
                const rows = groups.flat();
                this.remoteSearchResults = pageNumber === 1 ? rows : (this.remoteSearchResults || []).concat(rows);
                return { data: { searchActive: true, searchResults: this.remoteSearchResults, searchHasMore: !!page && page.total > pageNumber * 20, searchEmptyText: this.remoteSearchResults.length ? '' : `没有匹配「${text}」的章节` } };
            });
        }
        this.remoteSearchText = '';
        if (!text) {
            return {
                data: {
                    searchKeyword: '',
                    searchActive: false,
                    searchResults: [],
                    searchEmptyText: ''
                }
            };
        }
        const pool = Array.isArray(this.bankIndex) ? this.bankIndex : [];
        const lower = text.toLowerCase();
        const results = pool
            .filter((item) => {
            const haystack = `${item.subjectName}${item.title}${item.chapterTitle}`.toLowerCase();
            return haystack.indexOf(lower) >= 0;
        })
            .slice(0, 12)
            .map((item) => ({
            id: item.id,
            bankId: item.bankId,
            subjectId: item.subjectId,
            subjectName: item.subjectName,
            title: item.title,
            chapterTitle: item.chapterTitle,
            metaText: item.metaText
        }));
        return {
            data: {
                searchKeyword: text,
                searchActive: true,
                searchResults: results,
                searchEmptyText: results.length ? '' : `没有匹配「${text}」的章节`
            }
        };
    }
    clearSearch() {
        return this.updateSearch('');
    }
    toggleFilter() {
        this.filterUnfinished = !this.filterUnfinished;
        const allRows = Array.isArray(this.allRows) ? this.allRows : [];
        const rows = this.filterRows(allRows);
        return {
            data: {
                filterUnfinished: this.filterUnfinished,
                rows,
                chapterGroups: this.groupChapterRows(rows),
                hiddenRowCount: allRows.length - rows.length,
                listEmptyText: this.resolveListEmptyText(allRows.length, rows.length)
            }
        };
    }
    /**
     * 打开答题配置抽屉。
     *
     * @param {object} target { type: 'bank' | 'subject', bankId?, subjectId? }
     */
    openConfig(target) {
        const normalized = target || {};
        if (normalized.type !== 'bank') {
            return this.openRemoteSubjectConfig(normalized.subjectId);
        }
        const detail = this.repository.getSubjectDetail(normalized.subjectId);
        const sheet = Object.assign({}, DEFAULT_SHEET);
        if (!detail) {
            return null;
        }
        if (normalized.type === 'bank') {
            const bank = (detail.banks || []).find((item) => item.id === normalized.bankId);
            if (!bank) {
                return null;
            }
            this.sheetTarget = {
                type: 'bank',
                subjectId: detail.id,
                bankId: bank.id,
                name: bank.name,
                title: bank.name,
                questionCount: bank.questionCount || 0
            };
        }
        else {
            this.sheetTarget = {
                type: 'subject',
                subjectId: detail.id,
                bankId: '',
                name: detail.name,
                title: detail.name,
                questionCount: detail.questionCount || 0
            };
        }
        this.sheet = sheet;
        return this.buildConfigOpenResult();
    }
    openBankConfig(subjectId, bankId, chapterId) {
        return Promise.all([
            this.repository.loadRemoteBank(this.storage, bankId),
            this.repository.loadRemoteChapters(this.storage, bankId)
        ]).then(([bank, chapters]) => {
            if (!bank || !chapters)
                return null;
            if (chapterId && !chapters.some(chapter => chapter.id === chapterId))
                return { command: { type: 'toast', title: '章节已更新，请刷新后重试' } };
            const result = this.openConfig({ type: 'bank', subjectId: bank.subjectId, bankId });
            if (!result || !this.sheetTarget)
                return null;
            this.sheetTarget.chapters = chapters || [];
            this.setSheetChapter(chapterId || '');
            return Object.assign({}, result, { data: Object.assign({}, result.data, this.buildSheetData()) });
        });
    }
    async restorePendingPractice() {
        const pending = this.storage && this.storage.get('qandaPendingPractice');
        if (!pending || !this.repository.getAuth(this.storage).loggedIn)
            return null;
        const result = pending.bankIds ? await this.openSubjectConfig(pending.subjectId) : await this.openBankConfig(pending.subjectId, pending.bankId);
        if (pending.bankIds && this.sheetTarget && this.sheetTarget.banks)
            this.sheet.bankIds = String(pending.bankIds).split(',').filter(id => this.sheetTarget.banks.some(bank => bank.id === id));
        if (!result || !this.sheetTarget)
            return null;
        this.sheet.mode = pending.mode === 'test' ? 'test' : pending.mode === 'view' ? 'view' : 'practice';
        this.sheet.order = pending.mode === 'order' || pending.mode === 'view' ? 'order' : 'random';
        this.sheet.timed = !!pending.duration || pending.mode === 'test';
        this.sheet.duration = Number(pending.duration) || DEFAULT_DURATION_MINUTES;
        this.sheet.onlyWrong = pending.selectionKind === 'WRONG';
        this.setSheetChapter(pending.chapterId || '');
        this.storage.remove('qandaPendingPractice');
        return this.buildConfigOpenResult();
    }
    openSubjectConfig(subjectId) {
        return this.openConfig({ type: 'subject', subjectId });
    }
    async openRemoteSubjectConfig(subjectId) {
        const banks = [];
        let page = 1, result;
        do {
            result = await this.repository.loadRemoteBanks(this.storage, { subjectId, page });
            if (!result)
                return null;
            result.items.filter(bank => bank.activeQuestionCount > 0).forEach(bank => {
                if (!banks.some(item => item.id === bank.id))
                    banks.push(bank);
            });
            page += 1;
        } while (result.items.length && (page - 1) * result.pageSize < result.total);
        if (!banks.length)
            return { command: { type: 'toast', title: '当前没有可练习题库' } };
        if (banks.length === 1)
            return this.openBankConfig(subjectId, banks[0].id);
        const detail = this.repository.getSubjectDetail(subjectId);
        if (!detail)
            return null;
        this.sheetTarget = { type: 'subject', subjectId, name: detail.name, title: detail.name, banks };
        this.sheet = Object.assign({}, DEFAULT_SHEET, { bankIds: banks.map(bank => bank.id) });
        return this.buildConfigOpenResult();
    }
    setSheetBank(bankId) {
        const banks = this.sheetTarget && this.sheetTarget.banks || [];
        if (!banks.length)
            return null;
        const selected = this.sheet.bankIds || [];
        if (bankId === 'all')
            this.sheet.bankIds = selected.length === banks.length ? [] : banks.map(bank => bank.id);
        else if (banks.some(bank => bank.id === bankId))
            this.sheet.bankIds = selected.includes(bankId) ? selected.filter(id => id !== bankId) : selected.concat(bankId);
        if (!this.wrongCountFor(this.sheetTarget))
            this.sheet.onlyWrong = false;
        return { data: this.buildSheetData() };
    }
    selectedBanks() {
        return (this.sheetTarget && this.sheetTarget.banks || []).filter(bank => (this.sheet.bankIds || []).includes(bank.id));
    }
    buildConfigOpenResult() {
        this.remoteSearchText = '';
        const subjects = this.repository.getSubjectSummaries();
        const detail = this.repository.getSubjectDetail(this.sheetTarget.subjectId);
        this.railMode = 'subject';
        return {
            data: Object.assign(this.buildViewData(subjects, detail), this.buildSheetData(), {
                configSheetVisible: true,
                searchKeyword: '',
                searchActive: false,
                searchResults: []
            })
        };
    }
    closeConfig() {
        this.sheetTarget = null;
        this.sheet = Object.assign({}, DEFAULT_SHEET);
        return {
            data: {
                configSheetVisible: false
            }
        };
    }
    setSheetMode(mode) {
        this.sheet.mode = resolveModeValue(mode);
        this.sheet.timed = this.sheet.mode === 'test' ? true : this.sheet.timed;
        return {
            data: this.buildSheetData()
        };
    }
    setSheetOrder(order) {
        this.sheet.order = resolveOrderValue(order);
        return {
            data: this.buildSheetData()
        };
    }
    setSheetChapter(id) {
        if (!this.sheetTarget || (id && !(this.sheetTarget.chapters || []).some(chapter => chapter.id === id)))
            return null;
        this.sheet.chapterId = id || '';
        return { data: this.buildSheetData() };
    }
    setSheetTimed(timed) {
        this.sheet.timed = !!timed;
        this.sheet.duration = this.sheet.duration || DEFAULT_DURATION_MINUTES;
        return {
            data: this.buildSheetData()
        };
    }
    selectDuration(value) {
        const duration = Number(value);
        if (!Number.isFinite(duration) || duration <= 0) {
            return null;
        }
        this.sheet.duration = duration;
        return {
            data: this.buildSheetData()
        };
    }
    setSheetOnlyWrong(onlyWrong) {
        const target = this.sheetTarget;
        const wrongCount = this.wrongCountFor(target);
        if (onlyWrong && !wrongCount) {
            // 这一章没有错题：开关不生效，用 toast 说清楚，避免点了没反应
            return {
                data: Object.assign(this.buildSheetData(), { sheetOnlyWrong: false }),
                command: {
                    type: 'toast',
                    title: '当前范围暂无错题'
                }
            };
        }
        this.sheet.onlyWrong = !!onlyWrong;
        return {
            data: this.buildSheetData()
        };
    }
    wrongCountFor(target) {
        if (!target)
            return 0;
        if (target.banks)
            return this.selectedBanks().reduce((sum, bank) => sum + (bank.progress && bank.progress.wrongBookCount || 0), 0);
        const chapter = (target.chapters || []).find(chapter => chapter.id === this.sheet.chapterId);
        if (chapter)
            return chapter.progress && chapter.progress.wrongBookCount || 0;
        const detail = this.repository.getSubjectDetail(target.subjectId);
        const scope = target.type === 'bank' ? detail && detail.banks.find(bank => bank.id === target.bankId) : detail;
        return scope && scope.progress && scope.progress.wrongBookCount || 0;
    }
    buildSheetData() {
        return buildPracticeConfig(this.sheet, this.sheetTarget, this.selectedBanks(), this.wrongCountFor(this.sheetTarget));
    }
    resolveRouteMode() {
        return resolveRouteMode(this.sheet);
    }
    confirmConfig(currentState) {
        const state = currentState || {};
        const target = this.sheetTarget || {
            type: 'subject',
            subjectId: state.subjectId || '',
            bankId: '',
            name: '',
            title: '',
            questionCount: (state.stats && state.stats.total) || 0
        };
        const routeMode = this.resolveRouteMode();
        const query = [];
        const selected = this.selectedBanks();
        if (target.banks && !selected.length)
            return { command: { type: 'toast', title: '请至少选择一个题库' } };
        if (selected.length > 100)
            return { command: { type: 'toast', title: '每次最多选择 100 个题库' } };
        const bankId = selected.length ? selected[0].id : target.bankId;
        if (target.banks) {
            query.push(`subjectId=${encodeURIComponent(target.subjectId)}`, `bankId=${encodeURIComponent(bankId)}`, `bankIds=${encodeURIComponent(selected.map(bank => bank.id).join(','))}`, `title=${encodeURIComponent(target.title)}`);
        }
        else if (target.type === 'bank') {
            query.push(`subjectId=${encodeURIComponent(target.subjectId)}`);
            query.push(`bankId=${encodeURIComponent(target.bankId)}`);
            if (this.sheet.chapterId)
                query.push(`chapterId=${encodeURIComponent(this.sheet.chapterId)}`);
        }
        else {
            query.push(`subjectId=${encodeURIComponent(target.subjectId)}`);
            query.push('scope=subject');
        }
        if (this.sheet.onlyWrong)
            query.push('selectionKind=WRONG');
        query.push(`mode=${encodeURIComponent(routeMode)}`);
        if (this.sheet.timed && routeMode !== 'view') {
            query.push(`duration=${encodeURIComponent(this.sheet.duration)}`);
        }
        query.push(`seed=${Date.now()}`);
        const buildCommand = (count) => ({
            data: {
                configSheetVisible: false
            },
            command: {
                type: 'openRouteWithLoading',
                payload: {
                    url: `/page/practice/index?${query.join('&')}`,
                    title: routeMode === 'test' ? '正在生成试卷' : (routeMode === 'view' ? '正在打开题目' : '正在开始练习'),
                    description: this.sheet.timed && routeMode !== 'view'
                        ? `${count} 题 / ${this.sheet.duration} 分钟`
                        : `${count} 题 · ${target.title || target.name || '全部题目'}`
                }
            }
        });
        if (bankId) {
            return this.repository.previewRemotePracticeScope(this.storage, {
                questionBankId: bankId,
                ...(target.banks ? { questionBankIds: selected.map(bank => bank.id) } : {}),
                chapterIds: this.sheet.chapterId ? [this.sheet.chapterId] : [],
                count: this.sheet.onlyWrong ? 1000 : Math.min(selected.length ? selected.reduce((sum, bank) => sum + bank.activeQuestionCount, 0) : target.questionCount || 1000, 1000),
                order: ['practice', 'test'].includes(routeMode) ? 'RANDOM' : 'SEQUENTIAL',
                selectionKind: this.sheet.onlyWrong ? 'WRONG' : 'NORMAL',
                collectionChip: 'all'
            }).then(preview => {
                const availableCount = Math.min(Number(preview.selectedCount === undefined ? preview.availableCount : preview.selectedCount) || 0, 1000);
                if (!availableCount)
                    return { command: { type: 'toast', title: '当前范围没有可练习的题目' } };
                query.push(`count=${availableCount}`);
                if (preview.selectionKey)
                    query.push(`selectionKey=${preview.selectionKey}`);
                return buildCommand(availableCount);
            });
        }
        return buildCommand(target.questionCount || 0);
    }
    getShareMessage(subjectId) {
        const subject = this.repository.getSubjectDetail(subjectId);
        return {
            title: subject ? `QandA · ${subject.name}` : 'QandA 题库',
            // 题库是 tabBar 页面，分享路径不能携带参数，进入后落在默认科目
            path: '/page/bank-detail/index'
        };
    }
}
module.exports = {
    BankDetailViewModel,
    DEFAULT_DURATION_MINUTES,
    MODE_OPTIONS,
    ORDER_OPTIONS
};
