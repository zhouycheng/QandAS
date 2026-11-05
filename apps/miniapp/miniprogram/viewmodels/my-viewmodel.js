const practiceRepository = require('../repositories/practice-repository.js');
const { describeAuth, getProviderLabel } = require('../utils/auth-session.js');
const { normalizePreferences, describeChoiceLabel } = require('../utils/preferences.js');
const { DEFAULT_ORDER } = require('../utils/practice-layout.js');
const { maskEmail } = require('../utils/auth-form.js');
const LOGIN_URL = '/page/login/index';
const ACCOUNT_URL = '/page/account/index';
const SETTINGS_URL = '/page/settings/index';
// 「我的」集中提供账号、独立学习设置与关于入口。
const { AGREEMENT_TEXT, PRIVACY_TEXT } = require('../utils/legal-content.js');
function createNullStorage() {
    return {
        get() {
            return 0;
        },
        keys() {
            return [];
        },
        remove() { }
    };
}
/** 未登录时的资料头；读身份失败也用它，保证 tabBar 页面不会白屏 */
function createGuestAuthView() {
    return {
        loggedIn: false,
        displayName: '点击登录',
        avatarUrl: '',
        accountTag: '未登录',
        college: '',
        emailMasked: '',
        subText: '未登录',
        metaText: '登录后记录正式练习'
    };
}
function getInitialMyViewData() {
    return {
        auth: createGuestAuthView(),
        // 学习设置与关于：右侧摘要随偏好 / 提醒设置变化
        learnRows: [],
        links: [],
        // 弹层：'' | agreement | privacy
        sheet: '',
        sheetTitle: '',
        sheetBody: ''
    };
}
class MyViewModel {
    constructor(options) {
        const normalizedOptions = options || {};
        this.repository = normalizedOptions.repository || practiceRepository;
        this.storage = normalizedOptions.storage || createNullStorage();
    }
    refreshRemote(options) {
        return this.repository.refreshRemote(this.storage, 'profile', options).then(() => ({ data: Object.assign(this.projectRemote(), { profileError: '' }) })).catch((error) => ({ data: { profileError: error.message }, command: { type: 'toast', title: error.message } }));
    }
    projectRemote() {
        require('../repositories/remote-data-repository.js').getProfile(this.storage);
        const data = this.load().data;
        delete data.sheet;
        delete data.sheetTitle;
        delete data.sheetBody;
        return data;
    }
    static getInitialData() {
        return getInitialMyViewData();
    }
    load() {
        const preferences = normalizePreferences(this.repository.getPreferences(this.storage));
        const auth = this.readAuthView();
        return {
            data: Object.assign(getInitialMyViewData(), {
                auth,
                learnRows: [
                    { key: 'practice', title: '答题偏好', value: '文字大小：' + describeChoiceLabel(preferences, 'fontSize') },
                    { key: 'layout', title: '自定义布局', value: preferences.moduleOrder.join() === DEFAULT_ORDER.join() ? '默认布局' : '已自定义' },
                    { key: 'feedback', title: '反馈与处理结果', value: '' },
                    { key: 'countdown', title: '考试倒计时', value: '' },
                    { key: 'about', title: '关于题小搭', value: '' }
                ],
                links: [
                    { key: 'agreement', title: '用户协议' },
                    { key: 'privacy', title: '隐私政策' }
                ]
            })
        };
    }
    /**
     * 资料头视图。
     * 未登录：第二行给账号状态（未登录），第三行给引导；
     * 已登录：第二行学院（没填就退到身份来源），第三行脱敏邮箱。
     */
    readAuthView() {
        try {
            const auth = this.repository.getAuth(this.storage);
            const view = describeAuth(auth);
            if (!view.loggedIn) {
                return createGuestAuthView();
            }
            return {
                loggedIn: true,
                displayName: view.displayName,
                avatarUrl: view.avatarUrl,
                accountTag: view.accountTag,

                emailMasked: maskEmail(view.email),
                subText: getProviderLabel(view.provider) || view.accountTag,
                metaText: maskEmail(view.email) || '未绑定邮箱'
            };
        }
        catch (error) {
            return createGuestAuthView();
        }
    }
    /** 行点击：账号 / 学习设置 / 关于 / 协议，退出登录由页面加确认弹窗后调 logout() */
    tapRow(key) {
        if (key === 'feedback')
            return require('../utils/feedback-entry.js').feedbackEntry(this.storage);
        if (key === 'account' || key === 'profile') {
            const auth = this.readAuthView();
            return {
                command: {
                    type: 'navigate',
                    url: auth.loggedIn ? ACCOUNT_URL : LOGIN_URL
                }
            };
        }
        if (key === 'practice') {
            return {
                command: {
                    type: 'navigate',
                    url: SETTINGS_URL
                }
            };
        }
        if (key === 'layout') {
            return {
                command: {
                    type: 'navigate',
                    url: '/page/practice-layout/index'
                }
            };
        }
        if (key === 'countdown') return { command: { type: 'navigate', url: '/page/exam-countdown/index' } };
        if (key === 'about') {
            return { command: { type: 'navigate', url: '/page/about/index' } };
        }
        if (key === 'account-deletion') return { command: { type: 'navigate', url: this.readAuthView().loggedIn ? '/page/account-deletion/index' : LOGIN_URL } };
        if (key === 'agreement') {
            return this.openSheet('agreement');
        }
        if (key === 'privacy') {
            return this.openSheet('privacy');
        }
        return null;
    }
    openSheet(name) {
        if (name === 'agreement') {
            return {
                data: {
                    sheet: 'agreement',
                    sheetTitle: '用户协议',
                    sheetBody: AGREEMENT_TEXT
                }
            };
        }
        if (name === 'privacy') {
            return {
                data: {
                    sheet: 'privacy',
                    sheetTitle: '隐私政策',
                    sheetBody: PRIVACY_TEXT
                }
            };
        }
        return null;
    }
    closeSheet() {
        return {
            data: {
                sheet: ''
            }
        };
    }
    /** 退出登录：只清身份，本机学习数据保留 */
    logout() {
        if (!this.readAuthView().loggedIn) {
            return {
                command: {
                    type: 'toast',
                    title: '当前没有登录状态'
                }
            };
        }
        this.repository.logout(this.storage);
        return {
            data: this.load().data,
            command: {
                type: 'toast',
                title: '已退出登录'
            }
        };
    }
}
module.exports = {
    AGREEMENT_TEXT,
    MyViewModel,
    PRIVACY_TEXT
};
