const DEFAULT_DURATION_MINUTES = 10;
// 模式只保留三种语义：练习（即时给反馈）/ 模拟考（交卷才判）/ 背题（先看答案）
const MODE_OPTIONS = [
    { value: 'practice', label: '练习' },
    { value: 'test', label: '模拟考' },
    { value: 'view', label: '背题' }
];
const ORDER_OPTIONS = [
    { value: 'order', label: '顺序' },
    { value: 'random', label: '随机' }
];
const DURATION_OPTIONS = [5, 10, 15, 20].map((value) => ({
    value,
    label: `${value} 分钟`
}));
const DEFAULT_SHEET = {
    mode: 'practice',
    order: 'order',
    timed: false,
    duration: DEFAULT_DURATION_MINUTES,
    onlyWrong: false
};
function resolveModeValue(value) {
    const matched = MODE_OPTIONS.find((option) => option.value === value);
    return matched ? matched.value : DEFAULT_SHEET.mode;
}
function resolveOrderValue(value) {
    const matched = ORDER_OPTIONS.find((option) => option.value === value);
    return matched ? matched.value : DEFAULT_SHEET.order;
}
function resolveRouteMode(sheet) {
        if (sheet.mode === 'view') {
            return 'view';
        }
        if (sheet.mode === 'test') {
            return 'test';
        }
        return sheet.order === 'random' ? 'practice' : 'order';
    }
function buildPracticeConfig(sheet, target, selected, wrongCount) {
        const isView = sheet.mode === 'view';
        const chapter = target && (target.chapters || []).find(item => item.id === sheet.chapterId);
        const count = target && target.banks ? selected.reduce((sum, bank) => sum + bank.activeQuestionCount, 0) : chapter ? chapter.questionCount : target && target.questionCount;
        const startText = sheet.mode === 'test'
            ? '开始测试'
            : (isView ? '开始背题' : '开始答题');
        return {
            configTitle: '答题配置',
            configSubtitle: target ? `${target.title}${target.banks ? ' · 已选 ' + selected.length + ' 个题库' : chapter ? ' · ' + chapter.name : ''} · ${sheet.onlyWrong ? wrongCount : count} 题` : '',
            sheetBanks: (target && target.banks || []).map(bank => ({ id: bank.id, name: bank.name, selected: (sheet.bankIds || []).includes(bank.id) })),
            sheetAllBanksSelected: !!(target && target.banks && selected.length === target.banks.length),
            sheetSomeBanksSelected: !!(selected.length && target && target.banks && selected.length < target.banks.length),
            sheetStartDisabled: !!(target && target.banks && !selected.length),
            configTargetName: target ? target.name : '',
            sheetMode: sheet.mode,
            sheetOrder: sheet.order,
            sheetTimed: sheet.timed,
            sheetDuration: sheet.duration,
            sheetOnlyWrong: sheet.onlyWrong,
            sheetWrongCount: wrongCount,
            // 背题模式固定按原顺序看，顺序/随机没有意义
            sheetOrderDisabled: isView,
            modeOptions: MODE_OPTIONS,
            orderOptions: ORDER_OPTIONS,
            durationOptions: DURATION_OPTIONS,
            sheetStartText: startText,
            mode: resolveRouteMode(sheet),
            isViewMode: isView,
            selectedDuration: sheet.timed ? sheet.duration : 0
        };
    }
module.exports = { DEFAULT_DURATION_MINUTES, MODE_OPTIONS, ORDER_OPTIONS, DURATION_OPTIONS, DEFAULT_SHEET, resolveModeValue, resolveOrderValue, resolveRouteMode, buildPracticeConfig }
