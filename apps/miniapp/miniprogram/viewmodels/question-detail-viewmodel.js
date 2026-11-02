const practiceRepository = require('../repositories/practice-repository.js');
const { normalizePreferences } = require('../utils/preferences.js');
const { blankAnswerText } = require('../utils/fill-blank.js');
/**
 * 题目详情。
 *
 * 题目按 ID 读取；练习上下文提供已保存的作答与答案展示时机。
 */
function createNullStorage() {
    return {
        get() {
            return null;
        },
        set() { },
        remove() { }
    };
}
function getInitialQuestionDetailData() {
    return {
        ready: false,
        emptyText: '',
        questionId: '',
        subjectName: '',
        bankName: '',
        typeText: '',
        contentFormat: 'PLAIN_TEXT',
        presentation: 'STANDARD',
        codeLanguage: 'text',
        isShortAnswer: false,
        canReveal: false,
        stem: '',
        material: null,
        assetIds: [],
        imagePaths: [],
        scoringPoints: [],
        options: [],
        hasAnswer: false,
        answered: false,
        isCorrect: false,
        selectedText: '',
        correctText: '',
        explanation: '',
        isFavorite: false,
        // 题目详情页也是「读题」场景，字号偏好要跟着生效
        fontSize: 'normal'
    };
}
function decodeOptionValue(value) {
    return value ? decodeURIComponent(value) : '';
}
function getAnswerText(question, keys) {
    if (!question || !keys || !keys.length) {
        return '';
    }
    return keys
        .map((key) => {
        const option = question.options.find((item) => item.key === key);
        return option ? `${key}. ${option.text}` : key;
    })
        .join('  ');
}
class QuestionDetailViewModel {
    constructor(options) {
        const normalizedOptions = options || {};
        this.repository = normalizedOptions.repository || practiceRepository;
        this.storage = normalizedOptions.storage || createNullStorage();
    }
    static getInitialData() {
        return getInitialQuestionDetailData();
    }
    load(options) {
        const normalizedOptions = options || {};
        const questionId = decodeOptionValue(normalizedOptions.id);
        const sessionId = decodeOptionValue(normalizedOptions.sessionId);
        if (!questionId) {
            return {
                data: Object.assign(getInitialQuestionDetailData(), {
                    ready: true,
                    emptyText: '未找到这道题，请返回列表重新打开'
                })
            };
        }
        const entries = typeof this.repository.findQuestionEntries === 'function'
            ? this.repository.findQuestionEntries([questionId])
            : [];
        let entry = entries && entries.length ? entries[0] : null;
        const onlineContext = this.onlineContext(sessionId, questionId);
        if (onlineContext)
            entry = Object.assign({}, entry || {}, { question: onlineContext.question });
        if (!entry || (entry.question.complete === false)) {
            return {
                data: Object.assign(getInitialQuestionDetailData(), {
                    ready: false,
                    emptyText: ''
                })
            };
        }
        const question = entry.question;
        this.feedbackQuestion = { id: question.id, revisionId: question.revisionId };
        const answer = onlineContext ? onlineContext.answer : null;
        const local = null;
        const reveal = onlineContext ? onlineContext.reveal : false;
        const favoriteIds = typeof this.repository.getFavoriteIds === 'function'
            ? this.repository.getFavoriteIds(this.repository.getFavorites(this.storage))
            : [];
        const selectedKeys = answer ? answer.selectedKeys || [] : [];
        return {
            data: {
                ready: true,
                emptyText: '',
                questionId: question.id,
                subjectName: entry.subjectName || '',
                bankName: entry.bankName || '',
                typeText: question.typeText || '',
                contentFormat: question.contentFormat || 'PLAIN_TEXT',
                presentation: question.presentation || 'STANDARD',
                codeLanguage: question.codeLanguage || 'text',
                isShortAnswer: !!question.isShortAnswer,
                blankInputs: question.isFillBlank ? (question.blanks || []).map((_, i) => ({ value: answer && (answer.blanks || [])[i] || '' })) : null,
                canReveal: reveal,
                stem: question.stem || '',
                material: question.material || null,
                assetIds: question.assetIds || [],
                imagePaths: question.imagePaths || [],
                scoringPoints: reveal ? question.scoringPoints || [] : [],
                options: (question.options || []).map((option) => ({
                    key: option.key,
                    label: option.label || option.key,
                    text: option.text || '',
                    isCorrectOption: reveal && question.answerKeys.indexOf(option.key) >= 0,
                    isSelected: selectedKeys.indexOf(option.key) >= 0
                })),
                hasAnswer: reveal && !!answer,
                answered: !!answer,
                isCorrect: answer ? !!answer.isCorrect : false,
                selectedText: answer ? (answer.blanks || []).join(' / ') || answer.text || getAnswerText(question, answer.selectedKeys) || '未作答' : '',
                correctText: reveal ? (question.isFillBlank ? blankAnswerText(question) : question.referenceAnswer || getAnswerText(question, question.answerKeys)) : '',
                explanation: reveal ? question.explanation || '本题暂无解析。' : '',
                isFavorite: favoriteIds.indexOf(question.id) >= 0,
                fontSize: this.readFontSize()
            }
        };
    }
    onlineContext(sessionId, questionId) {
        if (!sessionId || false || false)
            return null;
        const online = require('../repositories/online-practice.js');
        const runtime = online.current();
        if (!runtime)
            return null;
        const trial = require('../repositories/trial-practice.js').get(this.storage, sessionId);
        const snapshot = trial || (this.repository.getAuth(this.storage).loggedIn ? runtime.get(sessionId) : null);
        if (!snapshot)
            return null;
        const item = ((snapshot.result && snapshot.result.items) || snapshot.items || []).find((item) => item.question.id === questionId);
        if (!item)
            return null;
        const local = snapshot.localState || {};
        const answer = (local.answers || []).find((answer) => answer && answer.questionId === questionId) || (item.answer ? { selectedKeys: item.answer.optionKeys || (typeof item.answer.value === 'boolean' ? [String(item.answer.value)] : []), text: item.answer.text || '', blanks: item.answer.blanks || [], confirmed: item.confirmed, isCorrect: item.outcome === 'CORRECT' } : null);
        const reveal = snapshot.status === 'SUBMITTED' || local.status === 'SUBMITTED' || ((snapshot.configuration || snapshot.route || {}).mode === 'view') || (snapshot.feedback === 'IMMEDIATE' && item.question.type !== 'SHORT_ANSWER' && answer && answer.confirmed);
        return { question: online.mapQuestion(item, (snapshot.offlineGrading || []).find((grading) => grading.itemId === item.itemId)), answer, reveal };
    }
    refreshRemote(options) {
        if (options && options.sessionId && this.onlineContext(decodeOptionValue(options.sessionId), decodeOptionValue(options.id)))
            return Promise.resolve(this.load(options));
        if (!options || !options.id)
            return Promise.resolve(null);
        return this.repository.loadRemoteQuestion(this.storage, decodeOptionValue(options.id)).then(() => this.load(options))
            .catch(error => ({ data: { ready: true, emptyText: error.message || '题目加载失败，请重试' } }));
    }
    /** 读偏好失败时退回标准字号：少一个字号不该让整页打不开 */
    readFontSize() {
        try {
            return normalizePreferences(this.repository.getPreferences(this.storage)).fontSize;
        }
        catch (error) {
            return 'normal';
        }
    }
    toggleFavorite(questionId) {
        if (!questionId || typeof this.repository.toggleQuestionFavorite !== 'function') {
            return null;
        }
        const result = this.repository.toggleQuestionFavorite(this.storage, questionId);
        if (result && typeof result.then === 'function')
            return result.then((value) => ({ data: { isFavorite: !!value.value } }));
        return { data: { isFavorite: !!result.value } };
    }
    openFeedback() {
        return require('../utils/feedback-entry.js').feedbackEntry(this.storage, 'question', this.feedbackQuestion);
    }
}
module.exports = {
    QuestionDetailViewModel,
    getInitialQuestionDetailData
};
