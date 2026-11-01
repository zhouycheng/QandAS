const { AuthFormViewModel } = require('./auth-form-viewmodel.js')
const { validateRegister } = require('../utils/auth-form.js')
const { successCommand } = require('../utils/profile-rules.js')

/**
 * 注册页视图模型（设计稿 772:1036）。
 *
 * 字段：邮箱 / 邮箱验证码 / 设置密码 / 确认密码 / 同意协议。
 * 注册成功后直接进登录态 —— 让用户注册完再登一次是多余的，
 * 随后完善个人资料，再返回业务入口。
 */
class RegisterViewModel extends AuthFormViewModel {
  _validate() {
    return validateRegister(this.fields)
  }

  _submit() {
    return this.repository.registerAccount(this.storage, {
      email: this.fields.email,
      code: this.fields.code,
      password: this.fields.password
    })
  }

  buildSuccessCommand(result) {
    return successCommand(result && result.auth, '注册成功')
  }
}

module.exports = {
  RegisterViewModel
}
