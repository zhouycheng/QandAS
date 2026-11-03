const { AuthFormViewModel } = require('./auth-form-viewmodel.js');
const { validateLogin, isValidEmail } = require('../utils/auth-form.js');
const { successCommand } = require('../utils/profile-rules.js');
/**
 * 登录页视图模型（设计稿 763:567）。
 *
 * 一条主路径 + 一条备选：
 *   邮箱 + 密码  → repository.loginWithEmail
 *   微信登录     → repository.login（wx.login 获取登录凭证）
 *
 * 页面只负责把输入传进来、把 command 执行掉，判断都在这里。
 */
class LoginViewModel extends AuthFormViewModel {
    constructor(options) {
        super(options);
        const settings = options || {};
        if (isValidEmail(settings.email))
            this.fields.email = settings.email.trim();
        this.codeMode = false;
        this.loginNotice = settings.returnReason === 'email-updated' ? '邮箱已更换，请使用新邮箱和原密码重新登录。'
            : settings.returnReason === 'email-bound' ? '邮箱已绑定，请重新登录，学习记录保留。'
                : settings.returnReason === 'password-updated' ? '密码已更改，请使用新密码重新登录。' : '';
    }
    buildData() { return Object.assign(super.buildData(), { loginNotice: this.loginNotice || '', codeMode: this.codeMode }); }
    _validate() {
        if (this.codeMode) return !isValidEmail(this.fields.email) ? { ok: false, field: 'email', message: '请输入有效邮箱' } : !/^\d{6}$/.test(this.fields.code) ? { ok: false, field: 'code', message: '请输入六位验证码' } : !this.fields.agreed ? { ok: false, field: 'agreed', message: '请阅读并同意用户协议和隐私政策' } : { ok: true };
        return validateLogin(this.fields);
    }
    _submit() {
        if (this.codeMode) return this.repository.loginWithCode(this.storage, { email: this.fields.email, code: this.fields.code });
        return this.repository.loginWithEmail(this.storage, {
            email: this.fields.email,
            password: this.fields.password
        });
    }
    toggleMode() { if (!this.submitting && !this.sendingCode) { this.codeMode = !this.codeMode; this.fields.password = ''; this.fields.code = ''; this.errorField = ''; } return { data: this.buildData() }; }
    buildSuccessCommand(result) {
        return successCommand(result && result.auth, '登录成功');
    }
    /**
     * 微信登录：与邮箱通道并存（设计稿里它是「或」下面的备选按钮）。
     * wx.login 必然异步，所以这里固定返回 Promise。
     */
    wechatLogin() {
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
