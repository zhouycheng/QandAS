const { AuthFormViewModel } = require('./auth-form-viewmodel.js');
const { validateLogin, isValidEmail } = require('../utils/auth-form.js');
const { successCommand } = require('../utils/profile-rules.js');
class LoginViewModel extends AuthFormViewModel {
    constructor(options) {
        super(options);
        const settings = options || {};
        if (isValidEmail(settings.email))
            this.fields.email = settings.email.trim();
        this.codeMode = true;
        this.loginNotice = settings.returnReason === 'email-updated' ? '邮箱已更换，请使用新邮箱验证码登录。'
            : settings.returnReason === 'email-bound' ? '邮箱已绑定，请重新登录，学习记录保留。' : '';
    }
    isTestAccount() { return /^qandatest[0-9]+@qanda\.mail$/i.test(this.fields.email.trim()); }
    setField(name, value) {
        const previous = this.isTestAccount();
        super.setField(name, value);
        if (name === 'email' && previous !== this.isTestAccount()) {
            this.fields.password = '';
            this.fields.code = '';
            this.errorField = '';
        }
        return { data: this.buildData() };
    }
    buildData() { return Object.assign(super.buildData(), { loginNotice: this.loginNotice || '', codeMode: this.codeMode && !this.isTestAccount(), testAccount: this.isTestAccount() }); }
    _validate() {
        if (this.isTestAccount() && !/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{16}$/.test(this.fields.password)) return { ok: false, field: 'password', message: '请输入管理员提供的16位测试登录码' };
        if (this.codeMode && !this.isTestAccount()) return !isValidEmail(this.fields.email) ? { ok: false, field: 'email', message: '请输入有效邮箱' } : !/^\d{6}$/.test(this.fields.code) ? { ok: false, field: 'code', message: '请输入六位验证码' } : !this.fields.agreed ? { ok: false, field: 'agreed', message: '请阅读并同意用户协议和隐私政策' } : { ok: true };
        return validateLogin(this.fields);
    }
    _submit() {
        if (this.codeMode && !this.isTestAccount()) return this.repository.loginWithCode(this.storage, { email: this.fields.email, code: this.fields.code });
        return this.repository.loginWithEmail(this.storage, {
            email: this.fields.email,
            password: this.fields.password
        });
    }
    sendCode(purpose) {
        if (this.isTestAccount()) return Promise.resolve({ data: this.buildData(), command: { type: 'toast', title: '请在管理端查看测试登录码' } });
        return super.sendCode(purpose);
    }
    buildSuccessCommand(result) {
        return successCommand(result && result.auth, '登录成功');
    }
    /**
     * 微信登录：与邮箱通道并存（设计稿里它是「或」下面的备选按钮）。
     * wx.login 必然异步，所以这里固定返回 Promise。
     */
    wechatLogin() {
        if (!this.fields.agreed) return Promise.resolve({ data: this.buildData(), command: { type: 'toast', title: '请阅读并同意用户协议和隐私政策' } });
        if (this.submitting) {
            return Promise.resolve({ data: this.buildData() });
        }
        this.submitting = true;
        return this.repository
            .login(this.storage)
            .then((outcome) => this.afterSubmit(outcome), () => this.afterSubmit({ ok: false, reason: '登录失败，请稍后重试' }));
    }
    logout() {
        this.repository.logout(this.storage);
        return {
            data: this.buildData(),
            command: {
                type: 'toast',
                title: '已退出登录'
            }
        };
    }
}
module.exports = {
    LoginViewModel
};
