const { buildBankView, buildChapterRows, groupChapterRows, chapterMetaText } = require('../models/bank-detail-presentation.js');
const practiceRepository = require('../repositories/practice-repository.js');
const { PracticePresetsViewModel } = require('./practice-presets-viewmodel.js');
const { defaultPreset, validCount, validDuration, routeForPreset } = require('../utils/practice-presets.js');
const { preparePracticeRoute, routeQuery } = require('../repositories/practice-launch.js');
const { summarizeBankProgress, summarizeSubjectProgress } = require('../utils/practice-progress.js');
const MAX_KEYWORD_LENGTH = 20;
const { DEFAULT_DURATION_MINUTES, MODE_OPTIONS, DURATION_OPTIONS, DEFAULT_SHEET, resolveModeValue, resolveRouteMode, buildPracticeConfig } = require('../models/bank-practice-config.js');
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
        listEmptyText: '这个科目还没有章节',
        // 搜索
        searchKeyword: '',
        searchActive: false,
        searchResults: [],
        searchEmptyText: '',
        // 筛选：只看没刷完的章节
        // 答题配置抽屉
        configSheetVisible: false,
        configTitle: '答题配置',
        configSubtitle: '',
        configTargetName: '',
        sheetMode: DEFAULT_SHEET.mode,
        sheetModeDescription: MODE_OPTIONS[0].description,
        sheetAutoShowExplanation: true,
        sheetAutoNextWhenCorrect: false,
        sheetDuration: DEFAULT_SHEET.duration,
        sheetOnlyWrong: DEFAULT_SHEET.onlyWrong,
        sheetWrongCount: 0,
        sheetBanks: [],
        sheetAllBanksSelected: false,
        sheetSomeBanksSelected: false,
        sheetStartDisabled: false,
        modeOptions: MODE_OPTIONS,
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
class BankDetailViewModel {
    constructor(options) {
        const normalizedOptions = options || {};
        this.repository = normalizedOptions.repository || practiceRepository;
        this.storage = normalizedOptions.storage || null;
        this.railMode = 'subject';
        this.sheet = Object.assign({}, DEFAULT_SHEET);
        this.sheetTarget = null;
    }
    refreshRemote(subjectId, options) {
        const revision = this.catalogRevision = (this.catalogRevision || 0) + 1;
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
            if (revision !== this.catalogRevision) return null;
            if (this.repository.loadRemoteChapters) {
                const subjects = this.repository.getSubjectSummaries();
                const id = subjects.some(subject => subject.id === this.currentSubjectId) ? this.currentSubjectId : (subjects[0] || {}).id;
                const page = this.repository.getRemoteCatalogPage({ subjectId: id, page: this.remotePage || 1 }).data;
                await Promise.allSettled((page && page.items || []).map(bank => this.repository.loadRemoteChapters(this.storage, bank.id, options)));
            }
            return revision === this.catalogRevision ? { data: this.projectRemote() } : null;
        }).catch(() => revision === this.catalogRevision ? { data: this.projectRemote() } : null);
    }
    async openPublicBank(bankId, options) {
        const revision = this.catalogRevision = (this.catalogRevision || 0) + 1;
        const bank = await this.repository.loadRemoteBank(this.storage, bankId, options);
        if (revision !== this.catalogRevision) return null;
        if (!bank) throw new Error('题库已失效，请返回题库首页');
        this.currentSubjectId = bank.subjectId;
        this.directBankId = bank.id;
        await this.repository.loadRemoteChapters(this.storage, bank.id, options);
        if (revision !== this.catalogRevision) return null;
        const subjects = this.repository.getSubjectSummaries();
        const detail = this.repository.getSubjectDetail(bank.subjectId);
        return { data: Object.assign(this.buildViewData(subjects, Object.assign({}, detail, { banks: detail.banks.filter(item => item.id === bank.id) })), { catalogLoading: false, catalogError: '', catalogHasMore: false }) };
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
        if (this.directBankId) { ids.clear(); ids.add(this.directBankId); }
        const data = detail ? this.buildViewData(subjects, Object.assign({}, detail, { banks: detail.banks.filter(bank => ids.has(bank.id)) })) : { subject: null, subjects: [] };
        ['searchKeyword', 'searchActive', 'searchResults', 'searchEmptyText', 'configSheetVisible'].forEach(key => delete data[key]);
        const subjectState = this.repository.getRemoteSubjectPage(this.remoteSubjectPage || 1);
        const subjectPage = subjectState.data;
        const chapterStates = Array.from(ids).map(bankId => this.repository.getRemoteResourceState('chapters:' + bankId));
        data.loggedIn = !!this.repository.getAuth(this.storage).token;
        Object.assign(data, { catalogLoading: ((current.status === 'loading' || subjectState.status === 'loading') && !ids.size) || (!data.rows?.length && chapterStates.some(state => state.status === 'idle' || state.status === 'loading')),
            catalogError: current.error || subjectState.error || (chapterStates.find(state => state.error) || {}).error || '',
            catalogHasMore: !this.directBankId && !!current.data && (this.remotePage || 1) * 20 < current.data.total,
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
    /** 「最近在刷」定位到最近练习记录所属的科目。 */
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
    buildViewData(subjects, detail) {
        this.currentSubjectId = detail.id;
        const progress = this.safeProgress();
        const subjectStats = summarizeSubjectProgress(progress, detail);
        const rows = (detail.banks || []).flatMap((bank, index) => {
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
        const recent = this.resolveRecentSubject(subjects);
        return buildBankView(subjects, detail, { subjectStats, rows, recent, railMode: this.railMode, chapterGroups: this.groupChapterRows(rows), sheet: this.buildSheetData() });
    }
    buildChapterRows(detail, bank) { return buildChapterRows(detail, bank, this.repository.getRemoteChapters(this.storage, bank.id)); }
    groupChapterRows(rows) { return groupChapterRows(rows, this.repository.getSubjectDetail(this.currentSubjectId)); }
    updateSearch(keyword, nextPage) {
        const request = this.searchRequest = (this.searchRequest || 0) + 1;
        const text = String(keyword === undefined || keyword === null ? '' : keyword)
            .trim()
            .slice(0, MAX_KEYWORD_LENGTH);
        if (text) {
            this.remoteSearchText = text;
            const pageNumber = nextPage || 1;
            return this.repository.loadRemoteBanks(this.storage, { keyword: text, page: pageNumber }).then(async () => {
                if (request !== this.searchRequest || this.remoteSearchText !== text)
                    return null;
                const page = this.repository.getRemoteCatalogPage({ keyword: text, page: pageNumber }).data;
                this.remoteSearchPage = pageNumber;
                const groups = await Promise.all((page && page.items || []).map(async (bank) => {
                    await this.repository.loadRemoteChapters(this.storage, bank.id);
                    return this.buildChapterRows({ id: bank.subjectId, banks: [bank] }, Object.assign({}, bank, { questionCount: bank.activeQuestionCount }))
                        .filter(row => `${bank.name}${row.title}`.toLowerCase().includes(text.toLowerCase()))
                        .map(row => Object.assign({}, row, { subjectName: bank.subjectName, bankName: bank.name, chapterTitle: row.title }));
                }));
                if (request !== this.searchRequest || this.remoteSearchText !== text)
                    return null;
                const rows = groups.flat();
                this.remoteSearchResults = pageNumber === 1 ? rows : (this.remoteSearchResults || []).concat(rows);
                return { data: { searchActive: true, searchResults: this.remoteSearchResults, searchHasMore: !!page && page.total > pageNumber * 20, searchEmptyText: this.remoteSearchResults.length ? '' : `没有匹配「${text}」的章节` } };
            });
        }
        this.remoteSearchText = '';
        return {
            data: {
                searchKeyword: '',
                searchActive: false,
                searchResults: [],
                searchEmptyText: ''
            }
        };
    }
    clearSearch() {
        return this.updateSearch('');
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
        this.sheet.duration = Number(pending.duration) || 0;
        this.sheet.presetId = '';
        this.sheet.presetName = '自定义';
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
        if (!this.sheet.presets) {
            const preferences = this.repository.getPreferences(this.storage);
            const preset = defaultPreset(preferences);
            this.sheet = Object.assign(this.sheet, preset, { presetId: preset.id, presetName: preset.name, order: preferences.practiceOrder, mockSelection: !!this.mockSelection, presets: preferences.practicePresets.filter(p => !this.mockSelection || p.mode === 'test') });
        }
        if (this.mockSelection) Object.assign(this.sheet, { mode: 'test', count: 'ALL', duration: 45, onlyWrong: false, durationError: '' });
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
        this.scopeRevision = (this.scopeRevision || 0) + 1;
        this.sheetTarget = null;
        this.sheet = Object.assign({}, DEFAULT_SHEET);
        return {
            data: {
                configSheetVisible: false
            }
        };
    }
    customSheet() { this.sheet.presetId = ''; this.sheet.presetName = '自定义'; }
    setSheetCount(count) {
        if (!validCount(count)) return null;
        this.sheet.count = count; this.customSheet();
        return { data: this.buildSheetData() };
    }
    setSheetMode(mode) {
        if (this.mockSelection) return null;
        this.sheet.mode = resolveModeValue(mode); this.sheet.durationError = ''; this.customSheet();
        return { data: this.buildSheetData() };
    }
    selectSheetPreset(index) {
        const preset = (this.sheet.presets || [])[index];
        if (!preset) return null;
        Object.assign(this.sheet, preset, { presetId: preset.id, presetName: preset.name, durationCustom: false, durationError: '' });
        return { data: this.buildSheetData() };
    }
    saveSheetPreset() {
        if (!this.sheetTarget) return null;
        if (this.sheet.mode !== 'view' && this.sheet.durationError) return { command: { type: 'toast', title: this.sheet.durationError } };
        const config = this.buildSheetData();
        const countLabel = config.sheetCount === 'ALL' ? '全部' : (config.countOptions.findIndex(option => option.value === config.sheetCount) + 1) + '档';
        const modeLabel = MODE_OPTIONS.find(option => option.value === this.sheet.mode).label;
        const durationLabel = this.sheet.mode === 'view' || !this.sheet.duration ? '不限时' : this.sheet.duration + '分钟';
        const name = `${modeLabel} - ${countLabel} - ${durationLabel}`;
        const editor = new PracticePresetsViewModel({ storage: this.storage, repository: this.repository });
        const result = editor.createFromConfig(name, this.sheet);
        if (!result.value) return { command: { type: 'toast', title: result.data.error } };
        this.sheet.presets = this.repository.getPreferences(this.storage).practicePresets;
        Object.assign(this.sheet, { presetId: result.value.id, presetName: result.value.name });
        return { data: this.buildSheetData(), command: { type: 'toast', title: result.duplicate ? '该配置已存在' : '预设已保存' } };
    }
    setSheetChapter(id) {
        if (!this.sheetTarget || (id && !(this.sheetTarget.chapters || []).some(chapter => chapter.id === id))) return null;
        this.sheet.chapterId = id || '';
        return { data: this.buildSheetData() };
    }
    selectDuration(value) {
        this.customSheet();
        this.sheet.durationCustom = value === 'custom';
        if (value !== 'custom') {
            if (!validDuration(Number(value))) return null;
            this.sheet.duration = Number(value); this.sheet.durationError = '';
        } else if (!this.sheet.duration) this.sheet.durationError = '请输入 1～1440 的整数分钟';
        return { data: this.buildSheetData() };
    }
    setCustomDuration(value) {
        this.sheet.duration = Number(value); this.customSheet();
        this.sheet.durationError = /^\d+$/.test(value) && validDuration(Number(value)) && Number(value) > 0 ? '' : '请输入 1～1440 的整数分钟';
        return { data: { sheetDurationError: this.sheet.durationError, sheetStartDisabled: this.buildSheetData().sheetStartDisabled } };
    }
    async refreshSheetScope() {
        const target = this.sheetTarget;
        if (!target) return null;
        const selected = this.selectedBanks();
        if (target.banks && !selected.length) { this.sheet.availableCount = 0; return { data: this.buildSheetData() }; }
        const revision = this.scopeRevision = (this.scopeRevision || 0) + 1;
        const bankId = selected.length ? selected[0].id : target.bankId;
        this.sheet.scopeLoading = true; this.sheet.scopeError = '';
        try {
            const preview = await this.repository.previewRemotePracticeScope(this.storage, { questionBankId: bankId, ...(target.banks ? { questionBankIds: selected.map(b => b.id) } : {}), chapterIds: this.sheet.chapterId ? [this.sheet.chapterId] : [], count: 1, completeFirstGroup: !this.sheet.onlyWrong, order: 'SEQUENTIAL', selectionKind: this.sheet.onlyWrong ? 'WRONG' : 'NORMAL', collectionChip: 'all' });
            if (revision !== this.scopeRevision || target !== this.sheetTarget) return null;
            this.sheet.availableCount = preview.availableCount === undefined ? preview.selectedCount : preview.availableCount;
        } catch (error) {
            if (revision !== this.scopeRevision || target !== this.sheetTarget) return null;
            this.sheet.scopeError = error.message;
        }
        this.sheet.scopeLoading = false;
        return { data: this.buildSheetData() };
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
        this.sheet.mockSelection = !!this.mockSelection;
        return buildPracticeConfig(this.sheet, this.sheetTarget, this.selectedBanks(), this.wrongCountFor(this.sheetTarget));
    }
    resolveRouteMode() {
        return resolveRouteMode(this.sheet);
    }
    confirmConfig() {
        const target = this.sheetTarget;
        if (!target) return null;
        const selected = this.selectedBanks();
        if (target.banks && !selected.length) return { command: { type: 'toast', title: '请至少选择一个题库' } };
        if (selected.length > 100) return { command: { type: 'toast', title: '每次最多选择 100 个题库' } };
        if (this.sheet.durationError && this.sheet.mode !== 'view') return { command: { type: 'toast', title: this.sheet.durationError } };
        return this.createConfiguredPractice(target, selected);
    }
    async createConfiguredPractice(target, selected) {
        const bankId = selected.length ? selected[0].id : target.bankId;
        const preferences = this.repository.getPreferences(this.storage);
        const route = routeForPreset(this.sheet, preferences);
        const result = await preparePracticeRoute(this.storage, this.repository, { questionBankId: bankId, ...(target.banks ? { questionBankIds: selected.map(b => b.id) } : {}), chapterIds: this.sheet.chapterId ? [this.sheet.chapterId] : [], selectionKind: this.sheet.onlyWrong ? 'WRONG' : 'NORMAL', collectionChip: 'all' }, route);
        Object.assign(result.route, { subjectId: target.subjectId });
        if (target.banks) result.route.bankIds = selected.map(b => b.id).join(',');
        if (this.sheet.chapterId) result.route.chapterId = this.sheet.chapterId;
        if (this.sheet.onlyWrong) result.route.selectionKind = 'WRONG';
        this.mockSelection = false;
        return { data: { configSheetVisible: false, mockSelection: false }, command: { type: 'openRouteWithLoading', payload: { url: '/page/practice/index?' + routeQuery(result.route), title: result.adjusted ? `保留完整阅读题组，实际 ${result.count} 题` : '正在开始答题' } } };
    }
    getShareMessage(subjectId, bankId) {
        const subject = this.repository.getSubjectDetail(subjectId);
        return {
            title: subject ? `题小搭 · ${subject.name}` : '题小搭题库',
            path: subjectId ? '/page/bank-detail/index?subjectId=' + encodeURIComponent(subjectId) + (bankId ? '&bankId=' + encodeURIComponent(bankId) : '') : '/page/subject-list/index'
        };
    }
}
module.exports = {
    BankDetailViewModel,
    DEFAULT_DURATION_MINUTES,
    MODE_OPTIONS,
};
