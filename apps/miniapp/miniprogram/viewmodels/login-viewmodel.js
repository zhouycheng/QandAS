const { AuthFormViewModel } = require('./auth-form-viewmodel.js')
const { validateLogin, isValidEmail } = require('../utils/auth-form.js')
const { successCommand } = require('../utils/profile-rules.js')

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
    super(options)
    const settings = options || {}
    if (isValidEmail(settings.email)) this.fields.email = settings.email.trim()
    this.loginNotice = settings.returnReason === 'email-updated' ? '邮箱已更换，请使用新邮箱和原密码重新登录。'
      : settings.returnReason === 'email-bound' ? '邮箱已绑定，请重新登录，学习记录保留。'
      : settings.returnReason === 'password-updated' ? '密码已更改，请使用新密码重新登录。' : ''
  }

  buildData() { return Object.assign(super.buildData(), { loginNotice: this.loginNotice || '' }) }

  _validate() {
    return validateLogin(this.fields)
  }

  _submit() {
    return this.repository.loginWithEmail(this.storage, {
      email: this.fields.email,
      password: this.fields.password
    })
  }

  buildSuccessCommand(result) {
    return successCommand(result && result.auth, '登录成功')
  }

  /**
   * 微信登录：与邮箱通道并存（设计稿里它是「或」下面的备选按钮）。
   * wx.login 必然异步，所以这里固定返回 Promise。
   */
  wechatLogin() {
    if (this.submitting) {
      return Promise.resolve({ data: this.buildData() })
    }

    this.submitting = true

    return this.repository
      .login(this.storage)
      .then((outcome) => this.afterSubmit(outcome), () => this.afterSubmit({ ok: false, reason: '登录接口异常' }))
  }

  logout() {
    this.repository.logout(this.storage)
    this.degradedNote = ''

    return {
      data: this.buildData(),
      command: {
        type: 'toast',
        title: '已退出登录'
      }
    }
  }
}

module.exports = {
  LoginViewModel
}
