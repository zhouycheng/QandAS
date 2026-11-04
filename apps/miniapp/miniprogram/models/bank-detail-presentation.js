const { summarizeBankProgress } = require('../utils/practice-progress.js');
function chapterMetaText(stats, hasProgress) {
    if (!stats) {
        return '';
    }
    return hasProgress ? `${stats.answered}/${stats.total}` : stats.totalText;
}
function buildBankView(subjects, detail, { subjectStats, rows, recent, railMode, chapterGroups, sheet }) {
    return Object.assign({
        subjectId: detail.id,
        subject: buildSubjectView(detail),
        stats: subjectStats,
        subjects: subjects.map((subject) => ({
            id: subject.id,
            name: subject.name,
            theme: subject.theme,
            active: railMode === 'subject' && subject.id === detail.id,
            recentActive: railMode === 'recent'
        })),
        railMode: railMode,
        recentSubjectId: recent ? recent.subjectId : '',
        recentSubjectName: recent ? subjectNameOf(subjects, recent.subjectId) : '',
        rows,
        chapterGroups,
        showBankTitles: (detail.bankCount > 1 || detail.banks.length > 1),
        listEmptyText: '这个科目还没有章节',
        // 搜索面板与抽屉由用户操作驱动，重新加载时一律回到关闭态
        searchKeyword: '',
        searchActive: false,
        searchResults: [],
        searchEmptyText: '',
        configSheetVisible: false
    }, sheet);
}
function buildChapterRows(detail, bank, chapters) {
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
function groupChapterRows(rows, detail) {
    return (detail && detail.banks || []).map(bank => ({ id: bank.id, name: bank.name, rows: rows.filter(row => row.bankId === bank.id) })).filter(group => group.rows.length);
}
function buildSubjectView(detail) {
    return {
        id: detail.id,
        name: detail.name,
        theme: detail.theme,
        description: detail.description,
        bankCount: detail.bankCount,
        questionCount: detail.questionCount
    };
}
function subjectNameOf(subjects, subjectId) {
    const matched = (subjects || []).find((subject) => subject.id === subjectId);
    return matched ? matched.name : '';
}
module.exports = { buildBankView, buildChapterRows, groupChapterRows, chapterMetaText };
