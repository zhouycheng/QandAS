const { PracticeSession, getInitialPracticeViewData } = require('../models/practice-session.js');
const preferences = require('../repositories/preference-repository.js');
const layout = require('../utils/practice-layout.js');
const SAMPLE = { id: 'layout-example', type: 'SINGLE_CHOICE', typeText: '单选题', stem: '学习新知识后，以下哪种复习方式更有助于形成长期记忆？', options: [{ key: 'A', label: 'A', text: '把所有复习集中在考试前一天' }, { key: 'B', label: 'B', text: '间隔一段时间回顾，并主动回忆关键内容' }, { key: 'C', label: 'C', text: '只反复阅读熟悉的段落' }], answerKeys: ['B'], scoringPoints: ['分散复习时间', '主动回忆知识'], explanation: '间隔复习与主动回忆可以帮助巩固记忆。尝试在当天、几天后重新回顾知识，再通过练习检查掌握情况。' };
class PracticeLayoutViewModel {
    constructor(options) { this.storage = options.storage; }
    static getInitialData() { return Object.assign(getInitialPracticeViewData(), { editLayout: true, moduleLabels: layout.LABELS, layoutDirty: false, dragId: '', dragTarget: '', dragScroll: 0, dragReset: 0, scrollTop: 0, explanationOpen: true }); }
    load() {
        const prefs = preferences.getPreferences(this.storage);
        this.order = prefs.moduleOrder;
        this.savedOrder = this.order.slice();
        const session = new PracticeSession({ quiz: { subjectId: 'layout-example', bankId: 'layout-example', sharePath: '/page/practice-layout/index', title: '答题布局预览', questions: [SAMPLE] }, mode: 'order', preferences: Object.assign({}, prefs, { autoShowExplanation: true, autoNextWhenCorrect: false, showOverviewEntry: true }) });
        session.reset();
        session.selectOption(1);
        session.state.isViewMode = true;
        session.showQuestionAtIndex(0);
        return { data: Object.assign(PracticeLayoutViewModel.getInitialData(), session.getViewData(), this.getLayoutData(), { editLayout: true, moduleLabels: layout.LABELS, explanationOpen: true }) };
    }
    getLayoutData() { return { layoutRanks: layout.ranks(this.order), layoutDirty: this.order.some((id, index) => id !== this.savedOrder[index]) }; }
    save() {
        if (!this.getLayoutData().layoutDirty) return {};
        try {
            preferences.savePreferences(this.storage, Object.assign(preferences.getPreferences(this.storage), { moduleOrder: this.order }));
            this.savedOrder = this.order.slice();
            return { data: this.getLayoutData(), command: { title: '布局已保存' } };
        }
        catch (error) {
            return { command: { title: '布局保存失败，请重试' } };
        }
    }
    drop(id, index) {
        this.order = layout.move(this.order, id, index);
        return { data: this.getLayoutData() };
    }
    reset() { this.order = layout.DEFAULT_ORDER.slice(); return { data: this.getLayoutData() }; }
}
module.exports = { PracticeLayoutViewModel };
