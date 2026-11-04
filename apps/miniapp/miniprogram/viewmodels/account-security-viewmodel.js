const { AccountSecurityRepository } = require('../repositories/account-security-repository.js');
const { uuid } = require('../repositories/api-transport.js');
const { isValidEmail, isValidCode, maskEmail } = require('../utils/auth-form.js');
class AccountSecurityViewModel {
    constructor(options) {
        this.repository = options.repository || new AccountSecurityRepository(options.storage);
        this.mode = 'email';
        this.stage = 'loading';
        this.fields = { email: '', code: '' };
        this.profile = {};
        this.now = options.now || Date.now;
        this.cooldownEndAt = 0;
    }
    static getInitialData() {
        return { title: '账号绑定', stage: 'loading', emailMasked: '',
            sending: false, submitting: false, errorText: '', errorField: '', loadError: '', actionLabel: '下一步' };
    }
    result(command) {
        const title = this.stage === 'verify' ? '验证当前邮箱' : (this.profile.email ? '更换邮箱' : '绑定邮箱');
        const actionLabel = this.stage === 'verify' ? '验证并继续' : '确认绑定';
        return { data: { title, stage: this.stage, emailMasked: maskEmail(this.profile.email),
                sending: !!this.sending, submitting: !!this.submitting, errorText: this.errorText || '', errorField: this.errorField || '', loadError: this.loadError || '', actionLabel }, command };
    }
    async load() {
        try {
            this.profile = await this.repository.load();
            this.stage = this.profile.isTestAccount ? 'test-account' : this.profile.email ? 'verify' : 'email';
            this.loadError = '';
            return this.result();
        }
        catch (error) {
            this.loadError = error.message;
            return this.fail(error);
        }
    }
    setField(key, value) {
        if (!Object.prototype.hasOwnProperty.call(this.fields, key))
            return null;
        if (key === 'email' && value !== this.fields.email) {
            this.challenge = null;
            this.sendIntent = null;
        }
        this.fields[key] = typeof value === 'string' ? value : '';
        this.errorText = '';
        this.errorField = '';
        return { data: { errorText: '', errorField: '', actionLabel: this.result().data.actionLabel } };
    }
    fail(error, field) {
        this.errorText = error.code === 'VERIFICATION_FAILED' ? '验证码错误或已过期，请检查后重试' : error.message || '请求失败，请重试';
        this.errorField = field || '';
        if (error.code === 'SESSION_CHANGED' || error.code === 'UNAUTHENTICATED')
            return this.result({ type: 'login', title: '请重新登录后继续' });
        if (error.code === 'VERSION_CONFLICT') {
            this.stage = 'loading';
            this.loadError = '账号资料已更新，请重新读取后继续';
        }
        return this.result();
    }
    intent(slot, input) {
        const body = JSON.stringify(input);
        if (!this[slot] || this[slot].body !== body)
            this[slot] = { body, key: uuid() };
        return this[slot].key;
    }
    purpose() { return this.stage === 'verify' ? 'CHANGE_EMAIL_OLD' : this.profile.email ? 'CHANGE_EMAIL_NEW' : 'BIND_EMAIL'; }
    async sendCode() {
        if (this.sending || this.submitting || this.cooldownEndAt > this.now() || !['verify', 'email'].includes(this.stage))
            return null;
        if (this.stage === 'email' && !isValidEmail(this.fields.email))
            return this.fail(new Error('请输入正确的邮箱地址'), 'email');
        if (this.stage === 'email' && this.fields.email.trim().toLowerCase() === (this.profile.email || '').toLowerCase())
            return this.fail(new Error('请填写新的邮箱地址'), 'email');
        const input = { purpose: this.purpose() };
        if (this.stage === 'email')
            input.email = this.fields.email.trim();
        this.sending = true;
        this.errorText = '';
        this.errorField = '';
        try {
            const challenge = await this.repository.issue(input, this.intent('sendIntent', input));
            this.challenge = Object.assign({}, challenge, { purpose: input.purpose, email: input.email });
            this.sendIntent = null;
            const seconds = challenge.resendAfterSeconds || 60;
            this.cooldownEndAt = this.now() + seconds * 1000;
            this.sending = false;
            return this.result({ type: 'cooldown', seconds, title: '验证码已发送' });
        }
        catch (error) {
            this.sending = false;
            if (error.statusCode)
                this.sendIntent = null;
            const result = this.fail(error);
            if (error.retryAfter) {
                this.cooldownEndAt = this.now() + error.retryAfter;
                result.command = { type: 'cooldown', seconds: Math.ceil(error.retryAfter / 1000) };
            }
            return result;
        }
    }
    validProof(proof) { return proof && Date.parse(proof.expiresAt) > this.now(); }
    async submit() {
        if (this.submitting || this.sending || !['verify', 'email'].includes(this.stage))
            return null;
        this.submitting = true;
        this.errorText = '';
        this.errorField = '';
        let command;
        try {
            {
                if (!this.validProof(this.challenge))
                    throw Object.assign(new Error('请先获取有效验证码'), { field: 'code' });
                if (!isValidCode(this.fields.code))
                    throw Object.assign(new Error('请输入 6 位验证码'), { field: 'code' });
                if (this.stage === 'verify') {
                    await this.repository.verify(this.challenge.id, { purpose: this.purpose(), code: this.fields.code });
                    this.oldProof = Object.assign({}, this.challenge, { code: this.fields.code });
                    this.challenge = null;
                    this.fields.code = '';
                    this.stage = 'email';
                    this.cooldownEndAt = 0;
                    command = { type: 'reset-cooldown' };
                }
                else {
                    if (this.profile.email && !this.validProof(this.oldProof)) {
                        this.stage = 'verify';
                        this.challenge = null;
                        throw new Error('原邮箱验证已过期，请重新验证');
                    }
                    const newEmail = this.fields.email.trim();
                    if (!isValidEmail(newEmail) || newEmail.toLowerCase() !== (this.challenge.email || '').toLowerCase())
                        throw Object.assign(new Error('请为当前填写的新邮箱获取验证码'), { field: 'email' });
                    const input = { expectedVersion: this.profile.version, newChallengeId: this.challenge.id, newCode: this.fields.code };
                    if (this.profile.email)
                        Object.assign(input, { oldChallengeId: this.oldProof.id, oldCode: this.oldProof.code });
                    await this.repository.email(input, this.intent('writeIntent', input));
                    this.repository.expire();
                    this.dispose();
                    command = { type: 'login', title: this.profile.email ? '邮箱已更换，请重新登录' : '邮箱已绑定，请重新登录', email: newEmail, reason: this.profile.email ? 'email-updated' : 'email-bound' };
                }
            }
            this.submitting = false;
            return this.result(command);
        }
        catch (error) {
            this.submitting = false;
            if (error.statusCode) {
                this.writeIntent = null;
            }
            return this.fail(error, error.field);
        }
    }
    dispose() {
        this.fields = { email: '', code: '' };
        this.oldProof = null;
        this.challenge = null;
        this.writeIntent = null;
        this.sendIntent = null;
        if (this.repository.close)
            this.repository.close();
    }
}
module.exports = { AccountSecurityViewModel };
