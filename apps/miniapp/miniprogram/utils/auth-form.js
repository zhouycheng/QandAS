const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/
const CODE_PATTERN = /^\d{6}$/
const ERROR = { agreed: '请阅读并同意用户协议和隐私政策' }
function trimText(value) { return typeof value === 'string' ? value.trim() : '' }
function isValidEmail(value) { return EMAIL_PATTERN.test(trimText(value)) }
function isValidCode(value) { return CODE_PATTERN.test(trimText(value)) }
function validateLogin(form) {
  if (!isValidEmail(form.email)) return { ok: false, field: 'email', message: '请输入有效邮箱' }
  if (!/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{16}$/.test(form.password)) return { ok: false, field: 'password', message: '请输入管理员提供的16位测试登录码' }
  if (!form.agreed) return { ok: false, field: 'agreed', message: ERROR.agreed }
  return { ok: true }
}
/**
 * 邮箱展示用的脱敏。
 * 「我的」页与设置页会把邮箱显示出来，完整邮箱摊在屏幕上没必要。
 * 只保留首字符与域名：abcd@qq.com → a***@qq.com
 */
function maskEmail(email) {
  const text = trimText(email)

  if (!text || text.indexOf('@') < 0) {
    return ''
  }

  const at = text.indexOf('@')
  const name = text.slice(0, at)
  const domain = text.slice(at)
  const head = name.slice(0, 1)

  return `${head}${name.length > 1 ? '***' : ''}${domain}`
}

module.exports = { CODE_PATTERN, EMAIL_PATTERN, ERROR, isValidCode, isValidEmail, maskEmail, trimText, validateLogin }
