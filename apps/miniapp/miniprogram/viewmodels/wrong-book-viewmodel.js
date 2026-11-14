const { preparePracticeRoute, routeQuery } = require('../repositories/practice-launch.js');
const practiceRepository = require('../repositories/practice-repository.js');
// 错题与收藏共用页面，列表、筛选及统计由服务端提供。
const TYPE_WRONG = 'wrong';
const TYPE_FAVORITE = 'favorite';
const PAGE_SIZE = 5;
const CHIPS = {
    wrong: [
        { key: 'all', text: '客观错题' },
        { key: 'subjective', text: '主观待复习' },
        { key: 'repeat', text: '反复错' },
        { key: 'recent', text: '近 7 天更新' }
    ],
    favorite: [
        { key: 'all', text: '全部' },
        { key: 'pending', text: '待练习' },
        { key: 'practiced', text: '已练习' }
    ]
};
const SORT_OPTIONS = {
    wrong: [
        { key: 'urgent', text: '最需复习' },
        { key: 'recent', text: '最近更新' }
    ],
    favorite: [
        { key: 'recent', text: '最近保存' },
        { key: 'old', text: '最早收藏' }
    ]
};
const DIST_TONES = ['tone-0', 'tone-1', 'tone-2', 'tone-3'];
const EMPTY_TEXT = {
    wrong: '错题本是空的，练习中答错的题会自动进来',
    favorite: '还没有收藏，答题时点「收藏」即可加入'
};
function createNullStorage() {
    return {
        get() {
            return null;
        },
        set() { },
        remove() { },
        keys() {
            return [];
        }
    };
}
function pad2(value) {
    return value < 10 ? `0${value}` : `${value}`;
}
function formatMonthDay(timestamp) {
    const value = Number(timestamp) || 0;
    if (!value) {
        return '';
    }
    const date = new Date(value);
    return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
}
function getInitialWrongBookViewData() {
    return {
        // 页面身份：wrong = 错题本，favorite = 收藏本
        type: TYPE_WRONG,
        title: '错题本',
        statTitle: '错题统计',
        statHint: '',
        stats: [],
        // 科目分布（分段条 + 图例）
        dist: [],
        hasDist: false,
        // 筛选
        subjectFilters: [{ id: 'all', name: '全部科目' }],
        subjectFilter: 'all',
        subjectFilterText: '全部科目',
        subjectMenuOpen: false,
        sortText: '最需复习',
        // 状态筛选 chips
        chips: [],
        activeChip: 'all',
        // 列表
        items: [],
        collectionLoading: false,
        collectionError: '',
        loadingMore: false,
        loadMoreError: '',
        hasMore: false,
        totalCount: 0,
        pageCount: 1,
        page: 1,
        manage: false,
        // 底部
        footerText: '开始练习',
        footerHint: '',
        emptyText: EMPTY_TEXT.wrong
    };
}
class WrongBookViewModel {
    constructor(options) {
        const normalizedOptions = options || {};
        this.repository = normalizedOptions.repository || practiceRepository;
        this.storage = normalizedOptions.storage || createNullStorage();
        this.state = {
            type: TYPE_WRONG,
            subjectFilter: 'all',
            sort: 'urgent',
            activeChip: 'all',
            page: 1,
            manage: false,
            subjectMenuOpen: false
        };
    }
    remoteOptions() {
        const filter = this.state.subjectFilter;
        return { kind: this.state.type === TYPE_FAVORITE ? 'FAVORITE' : 'WRONG', page: this.state.page,
            chip: this.state.activeChip, sort: this.state.sort,
            subjectId: filter !== 'all' && filter.indexOf('bank:') !== 0 ? filter : undefined,
            questionBankId: filter.indexOf('bank:') === 0 ? filter.slice(5) : undefined };
    }
    refreshRemote(options) {
        const scope = this.remoteOptions();
        return Promise.all(Array.from({ length: this.state.page }, (_, index) => this.repository.refreshRemote(this.storage, 'collection', Object.assign({}, scope, options, { page: index + 1 }))))
            .then(() => this.refresh({})).catch(() => this.refresh({}));
    }
    loadMore() {
        if (this.morePromise) return this.morePromise;
        const view = this.buildViewData();
        if (!view.hasMore && !view.loadMoreError || view.collectionLoading) return null;
        if (!view.loadMoreError) this.state.page++;
        this.loadingMore = true;
        this.morePromise = this.refreshRemote().finally(() => { this.loadingMore = false; this.morePromise = null; }).then(() => this.refresh({}));
        return this.morePromise;
    }
    reload() {
        this.state.page = 1;
        return this.refreshRemote({ force: true });
    }
    projectRemote() { return this.buildViewData(); }
    buildRemoteView() {
        const options = this.remoteOptions();
        const wrong = options.kind === 'WRONG';
        const resource = this.repository.getRemoteCollection(this.storage, options);
        const resources = Array.from({ length: this.state.page }, (_, index) => this.repository.getRemoteCollection(this.storage, Object.assign({}, options, { page: index + 1 })));
        const summaryState = this.repository.getRemoteResourceState('collectionSummary', { kind: options.kind });
        const page = resource.data || resources[0].data || { items: [], total: 0 };
        const rows = Array.from(new Map(resources.flatMap(value => value.data && value.data.items || []).map(item => [item.questionId, item])).values());
        const summary = this.repository.getRemoteCollectionSummary(this.storage, options.kind) || { total: 0, facets: [] };
        const subjects = [{ id: 'all', name: '全部科目' }];
        const distribution = new Map();
        const subjective = wrong && options.chip === 'subjective';
        const facets = subjective ? summary.subjectiveFacets || [] : summary.facets;
        const filterFacets = summary.facets.concat(summary.subjectiveFacets || []);
        const seenFilters = new Set();
        filterFacets.forEach(facet => {
            if (!seenFilters.has(facet.subjectId))
                subjects.push({ id: facet.subjectId, name: facet.subjectName });
            seenFilters.add(facet.subjectId);
            if (facets.includes(facet))
                distribution.set(facet.subjectId, { subjectName: facet.subjectName, count: ((distribution.get(facet.subjectId) || {}).count || 0) + facet.count });
            if (!seenFilters.has(facet.questionBankId))
                subjects.push({ id: 'bank:' + facet.questionBankId, name: `${facet.subjectName} · ${facet.questionBankName}` });
            seenFilters.add(facet.questionBankId);
        });
        const counts = { all: summary.total, subjective: summary.subjectiveCount, repeat: summary.repeatCount, recent: summary.recentCount, practiced: summary.practicedCount, pending: summary.pendingCount };
        const judged = (summary.rightCount || 0) + (summary.wrongCount || 0);
        const items = rows.map(item => ({ id: item.questionId, bankId: item.questionBankId, subjectId: item.subjectId,
            subjectName: item.subjectName, bankName: item.questionBankName, title: `${item.subjectName} · ${item.questionBankName}`,
            stem: item.stem, blankInputs: item.type === 'FILL_BLANK' ? [] : null, contentFormat: item.contentFormat || 'PLAIN_TEXT', typeText: ({ SINGLE_CHOICE: '单选题', MULTIPLE_CHOICE: '多选题', TRUE_FALSE: '判断题', FILL_BLANK: '填空题', SHORT_ANSWER: '简答题' })[item.type],
            wrongCount: item.wrongCount || 0, rightCount: item.rightCount || 0, practiced: !!item.practiced, available: item.available,
            updatedAt: Date.parse(item.lastPracticedAt || item.createdAt) || 0, dateText: formatMonthDay(Date.parse(item.lastPracticedAt || item.createdAt) || 0),
            badgeText: subjective ? '主观待复习 · 不计分' : wrong ? `错 ${item.wrongCount} 次` : item.practiced ? '已练习' : '待练习', badgeTone: wrong ? 'wrong' : item.practiced ? 'done' : 'todo' }));
        const pageCount = Math.max(1, Math.ceil(page.total / PAGE_SIZE));
        return Object.assign(getInitialWrongBookViewData(), {
            type: this.state.type, title: wrong ? '错题本' : '收藏本', statTitle: wrong ? '错题统计' : '收藏统计',
            statHint: wrong ? '客观错题与主观自评分开统计' : `已完成 ${summary.total ? Math.round((summary.practicedCount || 0) / summary.total * 100) : 0}%`,
            stats: wrong ? [
                { key: 'total', label: '客观错题', value: String(summary.total), unit: '道' },
                { key: 'accuracy', label: '正确率', value: judged ? String(Math.round(summary.rightCount / judged * 100)) : '—', unit: judged ? '%' : '' },
                { key: 'subjective', label: '主观待复习', value: String(summary.subjectiveCount || 0), unit: '道' }
            ] : [
                { key: 'total', label: '收藏题', value: String(summary.total), unit: '道' },
                { key: 'practiced', label: '已练习', value: String(summary.practicedCount || 0), unit: '道' },
                { key: 'pending', label: '待练习', value: String(summary.pendingCount || 0), unit: '道' }
            ],
            dist: Array.from(distribution.values()).map((item, i) => ({ name: item.subjectName, count: item.count,
                percent: (subjective ? summary.subjectiveCount : summary.total) ? Math.round(item.count / (subjective ? summary.subjectiveCount : summary.total) * 100) : 0, tone: DIST_TONES[i % DIST_TONES.length] })),
            hasDist: facets.length > 0, subjectFilters: subjects, subjectFilter: this.state.subjectFilter,
            subjectFilterText: this.getSubjectFilterText(subjects), subjectMenuOpen: this.state.subjectMenuOpen, sortText: this.getSortText(),
            chips: CHIPS[this.state.type].map(chip => ({ key: chip.key, text: `${chip.text} ${counts[chip.key] || 0}` })),
            activeChip: this.state.activeChip, items, totalCount: subjective ? summary.subjectiveCount || 0 : summary.total, filteredCount: page.total,
            pageCount, page: this.state.page,
            manage: !wrong && this.state.manage, footerText: `开始${subjective ? '主观复习' : wrong ? '错题' : '收藏'}练习 · ${page.total} 道`,
            footerHint: subjective ? '自评掌握后移出；未自评保持原记录' : wrong ? '掌握的题目会随练习结果更新' : '做错的题会自动进入错题本',
            emptyText: subjective ? '主动自评为待复习的主观题会显示在这里' : this.getEmptyText(wrong, summary.total), collectionLoading: !items.length && resource.status === 'loading', collectionError: (this.state.page === 1 ? resource.error : '') || summaryState.error,
            loadingMore: !!this.loadingMore, loadMoreError: this.state.page > 1 ? resource.error || '' : '', hasMore: items.length < page.total
        });
    }
    static getInitialData() {
        return getInitialWrongBookViewData();
    }
    /** 只在首次进入时读参数；之后 onShow 走 refresh，避免把用户切到一半的筛选重置掉 */
    load(options) {
        const normalizedOptions = options || {};
        const rawType = normalizedOptions.type || normalizedOptions.tab;
        this.state.type = rawType === TYPE_FAVORITE ? TYPE_FAVORITE : TYPE_WRONG;
        this.state.subjectFilter = 'all';
        this.state.activeChip = 'all';
        this.state.page = 1;
        this.state.manage = false;
        this.state.subjectMenuOpen = false;
        this.state.sort = this.state.type === TYPE_WRONG ? 'urgent' : 'recent';
        return this.refresh({});
    }
    refresh(patch) {
        this.state = Object.assign({}, this.state, patch || {});
        const data = this.buildViewData();
        return { data };
    }
    buildViewData() {
        return this.buildRemoteView();
    }
    getSubjectFilterText(options) {
        const matched = options.find((option) => option.id === this.state.subjectFilter);
        return matched ? matched.name : '全部科目';
    }
    getSortText() {
        const list = SORT_OPTIONS[this.state.type] || SORT_OPTIONS.wrong;
        const matched = list.find((option) => option.key === this.state.sort);
        return matched ? matched.text : list[0].text;
    }
    getEmptyText(isWrong, total) {
        if (!total) {
            return isWrong ? EMPTY_TEXT.wrong : EMPTY_TEXT.favorite;
        }
        return '当前筛选下没有题目，换个条件试试';
    }
    // ---------- 交互 ----------
    setChip(key) {
        const keys = (CHIPS[this.state.type] || []).map((chip) => chip.key);
        if (keys.indexOf(key) === -1 || key === this.state.activeChip) {
            return null;
        }
        this.state.activeChip = key;
        return this.refresh({ page: 1 });
    }
    toggleSort() {
        const list = SORT_OPTIONS[this.state.type] || SORT_OPTIONS.wrong;
        const index = Math.max(list.findIndex((option) => option.key === this.state.sort), 0);
        const next = list[(index + 1) % list.length];
        return this.refresh({ sort: next.key, page: 1 });
    }
    toggleSubjectMenu() {
        return this.refresh({ subjectMenuOpen: !this.state.subjectMenuOpen });
    }
    setSubject(subjectId) {
        const nextSubject = subjectId || 'all';
        return this.refresh({
            subjectFilter: nextSubject,
            subjectMenuOpen: false,
            page: 1
        });
    }
    toggleManage() {
        if (this.state.type === TYPE_WRONG) return null;
        return this.refresh({ manage: !this.state.manage });
    }
    // ---------- 写操作 ----------
    removeItem(questionId) {
        if (!questionId) {
            return null;
        }
        if (this.state.type === TYPE_WRONG) return null;
        return this.repository.removeQuestionFavorites(this.storage, [questionId]).then(() => this.refreshRemote({ force: true })).then(() => {
            if (this.state.page > this.buildViewData().pageCount) {
                this.state.page = this.buildViewData().pageCount;
                return this.refreshRemote();
            }
            return this.withToast('已取消收藏');
        });
    }
    clearFavorites() {
        if (this.state.type === TYPE_WRONG) return null;
        return this.repository.clearFavorites(this.storage).then(() => { this.state.page = 1; return this.refreshRemote({ force: true }); }).then(() => this.withToast('已清空收藏'));
    }
    withToast(title) {
        const result = this.refresh({});
        result.command = { type: 'toast', title };
        return result;
    }
    /** 服务端按当前筛选范围完整选题。 */
    createPracticeCommand() {
        const isWrong = this.state.type === TYPE_WRONG;
        const options = this.remoteOptions();
        const summary = this.repository.getRemoteCollectionSummary(this.storage, options.kind);
        const facets = (summary && (options.chip === 'subjective' ? summary.subjectiveFacets : summary.facets) || []).filter(item => (!options.subjectId || item.subjectId === options.subjectId) && (!options.questionBankId || item.questionBankId === options.questionBankId));
        if (!facets.length || !this.buildViewData().filteredCount)
            return { command: { type: 'toast', title: '当前没有可练习的题目' } };
        if (facets.length !== 1)
            return { command: { type: 'toast', title: '请先筛选同一题库的题目进行练习' } };
        return preparePracticeRoute(this.storage, this.repository, { questionBankId: facets[0].questionBankId, selectionKind: options.kind, collectionChip: options.chip }).then(result => {
            Object.assign(result.route, { subjectId: facets[0].subjectId, selectionKind: options.kind, collectionChip: options.chip });
            return { command: { type: 'navigate', url: '/page/practice/index?' + routeQuery(result.route) } };
        });
    }
}
module.exports = {
    PAGE_SIZE,
    TYPE_FAVORITE,
    TYPE_WRONG,
    WrongBookViewModel,
};
