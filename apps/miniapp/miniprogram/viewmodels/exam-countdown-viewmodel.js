const repository = require('../repositories/preference-repository.js');
const { buildExamList, validateExamInput, parseDateKey } = require('../utils/exam-countdown.js');
class ExamCountdownViewModel {
    constructor(options) { this.storage = options.storage; this.now = options.now || Date.now; this.draftName = ''; this.draftDate = ''; this.original = null; }
    static getInitialData() { return { exams: [], editorVisible: false, editingId: '', draftName: '', draftDate: '', canSave: false, formError: '' }; }
    load() { return { data: { exams: buildExamList(repository.getPreferences(this.storage).examCountdowns, this.now()) } }; }
    openEditor(id) {
        const exams = repository.getPreferences(this.storage).examCountdowns;
        const exam = id ? exams.find(item => item.id === id) : null;
        if (id && !exam) return { command: { title: '倒计时已删除，请刷新后重试' } };
        this.original = exam || null;
        this.draftName = exam ? exam.examName : '';
        this.draftDate = exam ? exam.examDate : '';
        return { data: { editorVisible: true, editingId: id || '', draftName: this.draftName, draftDate: this.draftDate, canSave: false, formError: '' } };
    }
    canSave() { return !!(this.draftName.trim() && this.draftDate && (!this.original || this.draftName.trim() !== this.original.examName || this.draftDate !== this.original.examDate)); }
    setDraftName(value) { this.draftName = typeof value === 'string' ? value : ''; return { data: { canSave: this.canSave(), formError: '' } }; }
    setDraftDate(value) { this.draftDate = typeof value === 'string' ? value : ''; return { data: { draftDate: this.draftDate, canSave: this.canSave(), formError: '' } }; }
    closeEditor() { this.original = null; this.draftName = ''; this.draftDate = ''; return { data: { editorVisible: false, editingId: '', draftName: '', draftDate: '', canSave: false, formError: '' } }; }
    saveExam() {
        if (!this.canSave()) return {};
        // 已结束的考试可以保留原日期，只修改名称。
        const now = this.original && this.draftDate === this.original.examDate ? parseDateKey(this.draftDate) : this.now();
        const check = validateExamInput(this.draftName, this.draftDate, now);
        if (!check.ok) return { data: { formError: check.reason } };
        const preferences = repository.getPreferences(this.storage);
        const exams = preferences.examCountdowns;
        if (this.original && !exams.some(item => item.id === this.original.id)) return { data: { formError: '倒计时已删除，请关闭后重试' } };
        const id = this.original ? this.original.id : 'exam-' + this.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const exam = Object.assign({ id }, check.value);
        const next = this.original ? exams.map(item => item.id === id ? exam : item) : exams.concat(exam);
        const result = this.persist(next, preferences);
        if (result.command) return { data: { formError: result.command.title } };
        const title = this.original ? '倒计时已更新' : '倒计时已添加';
        return { data: Object.assign({}, result.data, this.closeEditor().data), command: { title } };
    }
    deleteExam(id) {
        const preferences = repository.getPreferences(this.storage);
        const next = preferences.examCountdowns.filter(item => item.id !== id);
        if (next.length === preferences.examCountdowns.length) return {};
        const result = this.persist(next, preferences);
        if (!result.command) result.command = { title: '倒计时已删除' };
        return result;
    }
    persist(exams, preferences) {
        try {
            repository.savePreferences(this.storage, Object.assign({}, preferences, { examCountdowns: exams, examName: '', examDate: '' }));
            return this.load();
        }
        catch (error) {
            return { command: { title: '保存失败，请释放本机空间后重试' } };
        }
    }
}
module.exports = { ExamCountdownViewModel };
