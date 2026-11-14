const { PracticeSession, getInitialPracticeViewData } = require('../models/practice-session.js')
const preferences = require('../repositories/preference-repository.js')
const layout = require('../utils/practice-layout.js')
const SAMPLE = { id: 'layout-example', type: 'SINGLE_CHOICE', typeText: '单选题', stem: '小林学完新知识后，希望记得更牢。以下哪种复习方式更有助于形成长期记忆？', options: [{ key: 'A', label: 'A', text: '把复习集中在考试前一天。' }, { key: 'B', label: 'B', text: '间隔复习，并主动回忆关键内容。' }, { key: 'C', label: 'C', text: '反复阅读笔记，以熟悉程度判断掌握。' }, { key: 'D', label: 'D', text: '等到遗忘后，再重新学习。' }], answerKeys: ['B'], explanation: '间隔复习把学习分散到不同日期，主动回忆要求在没有提示时提取知识，两者结合能帮助巩固记忆并发现遗漏。先独立回答，再核对笔记，最后把容易混淆的概念放到下一次复习中。' }
class PracticeLayoutViewModel {
    constructor(options) { this.storage = options.storage; this.height = 0; this.previewing = false }
    static getInitialData() { return Object.assign(getInitialPracticeViewData(), { editLayout: true, previewFixed: false, moduleLabels: layout.LABELS, layoutDirty: false, dragId: '', dragTarget: '', dragScroll: 0, dragReset: 0, scrollTop: 0, stemPercent: 50, layoutMode: 'flow', paneHeights: { material: 0, stem: 0, response: 0 } }) }
    load() {
        this.preferences = preferences.getPreferences(this.storage)
        this.order = this.preferences.moduleOrder.slice()
        this.percent = this.preferences.practiceStemPercent
        this.mode = this.preferences.layoutMode
        this.saved = this.layoutValue()
        this.session = new PracticeSession({ quiz: { subjectId: 'layout-example', bankId: 'layout-example', sharePath: '/page/practice-layout/index', title: '答题布局预览', questions: [SAMPLE] }, mode: 'order', preferences: Object.assign({}, this.preferences, { autoNextWhenCorrect: false }) })
        this.session.reset()
        this.session.selectOption(1)
        return { data: Object.assign(PracticeLayoutViewModel.getInitialData(), this.session.getViewData(), this.getLayoutData()) }
    }
    layoutValue() { return { moduleOrder: this.order.slice(), practiceStemPercent: this.percent, layoutMode: this.mode } }
    getLayoutData() {
        return { layoutRanks: layout.ranks(this.order), stemPercent: this.percent, layoutMode: this.mode,
            preferences: Object.assign({}, this.preferences, this.layoutValue()), editLayout: !this.previewing,
            fixedLayout: this.mode === 'custom', previewFixed: this.mode === 'custom',
            paneHeights: this.mode === 'custom' ? layout.allocateHeights({ height: this.height, stemPercent: this.percent }).heights : { material: 0, stem: 0, response: 0 },
            layoutDirty: JSON.stringify(this.layoutValue()) !== JSON.stringify(this.saved) }
    }
    setHeight(height) { this.height = Math.max(0, Math.floor(height)); return { data: this.getLayoutData() } }
    setPercent(value) { if (this.mode !== 'custom') return {}; this.percent = layout.normalizeStemPercent(value); return { data: this.getLayoutData() } }
    toggleMode() { this.mode = this.mode === 'flow' ? 'custom' : 'flow'; return { data: this.getLayoutData() } }
    setPreview(previewing) {
        this.previewing = previewing
        this.session.reset()
        if (!previewing) this.session.selectOption(1)
        return this.previewResult()
    }
    previewResult() { return { data: Object.assign({}, this.session.getViewData(), this.getLayoutData(), { primaryActionText: '重新作答', scrollTop: 0 }) } }
    selectOption(index) { if (!this.previewing) return {}; this.session.selectOption(index); return { data: Object.assign({}, this.session.getViewData(), this.getLayoutData(), { primaryActionText: '重新作答' }) } }
    save() {
        if (!this.getLayoutData().layoutDirty) return {}
        try {
            preferences.savePreferences(this.storage, Object.assign(preferences.getPreferences(this.storage), this.layoutValue()))
            this.saved = this.layoutValue()
            return { data: this.getLayoutData(), command: { title: '布局已保存' } }
        } catch (error) { return { command: { title: '布局保存失败，请重试' } } }
    }
    drop(id, index) { this.order = layout.move(this.order, id, index); return { data: this.getLayoutData() } }
    reset() { this.order = layout.DEFAULT_ORDER.slice(); this.percent = 50; this.mode = 'flow'; return { data: this.getLayoutData() } }
}
module.exports = { PracticeLayoutViewModel }
