const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LoginViewModel } = require('../miniprogram/viewmodels/login-viewmodel.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const gateway = require('../miniprogram/repositories/auth-gateway.js')
const form = require('../miniprogram/utils/auth-form.js')
const cooldown = require('../miniprogram/utils/cooldown.js')
const root = path.join(__dirname, '../miniprogram')
const memory = () => { const raw = {}; return { raw, get: key => raw[key], set: (key, value) => { raw[key] = value }, remove: key => delete raw[key] } }
async function main() {
  assert(form.isValidEmail(' a+b@example.test '))
  assert(!form.isValidEmail('a@example'))
  assert(form.isValidCode('123456'))
  assert(!form.isValidCode('12345x'))
  assert.equal(form.maskEmail('abcd@example.test'), 'a***@example.test')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json')))
  assert(manifest.pages.includes('page/legal/index'))
  for (const obsolete of ['register', 'forgot-password', 'profile-setup', 'reminder']) assert(!manifest.pages.includes('page/' + obsolete + '/index'))
  const page = fs.readFileSync(path.join(root, 'page/login/index.wxml'), 'utf8')
  assert(page.includes('邮箱验证码') && page.includes('测试登录码'))
  assert(page.includes('data-kind="privacy"') && page.includes('catchtap="handleLegal"'))
  let sent = 0, login = 0, resolveLogin
  gateway.setAuthGateway({
    sendCode: () => { sent++; return { ok: true, challengeId: 'proof', expiresAt: new Date(Date.now() + 600000).toISOString(), cooldown: 60 } },
    loginByCode: input => { login++; assert.equal(input.challengeId, 'proof'); assert.equal(input.code, '123456'); return new Promise(resolve => { resolveLogin = resolve }) }
  })
  const storage = memory(), vm = new LoginViewModel({ storage })
  assert.equal(vm.load().data.codeMode, true)
  assert.equal((await vm.submit()).data.errorField, 'email')
  vm.setField('email', 'new@example.test')
  assert.equal((await vm.sendCode('login')).command.type, 'cooldown')
  assert.equal(sent, 1)
  vm.setField('code', '123456')
  assert.equal((await vm.submit()).data.errorField, 'agreed')
  vm.toggleAgreed()
  const pending = vm.submit()
  assert.equal((await vm.submit()).command, undefined)
  await Promise.resolve(); assert.equal(login, 1)
  resolveLogin({ ok: true, userId: 'user', token: 'session', email: 'new@example.test' })
  const result = await pending
  assert.equal(result.command.type, 'back')
  assert.equal(auth.getAuth(storage).userId, 'user')
  assert(!JSON.stringify(storage.raw).includes('123456'))
  const failed = new LoginViewModel({ storage: memory() })
  failed.setField('email', 'new@example.test'); failed.setField('code', '123456'); failed.toggleAgreed()
  gateway.setAuthGateway({ loginByCode: () => ({ ok: false, reason: '验证码不正确' }), sendCode: () => ({ ok: false, reason: '请稍后重试' }) })
  assert.equal((await failed.submit()).command.title, '验证码不正确')
  assert.equal((await failed.sendCode('login')).command.type, 'toast')
  assert.equal(failed.submitting, false)
  assert.equal(cooldown.remainingSeconds(6000, 1000), 5)
  assert.equal(cooldown.remainingSeconds(1000, 6000), 0)
  let definition, finishSend
  global.Page = value => { definition = value }
  global.wx = { showToast() {} }
  require('../miniprogram/page/login/index.js')
  const sender = { sendAuthCode: async () => ({ ok: false, reason: '发送失败' }) }
  const loginPage = Object.assign({}, definition, { data: structuredClone(definition.data),
    viewModel: new LoginViewModel({ repository: sender }),
    setData(patch) { Object.assign(this.data, patch) }
  })
  assert.equal(loginPage.data.codeSent, false)
  loginPage.handleEmailInput({ detail: { value: 'first@example.test' } })
  await loginPage.handleSendCode()
  assert.equal(loginPage.data.codeSent, false, '发送失败不显示有效期提示')
  sender.sendAuthCode = async () => ({ ok: true, cooldown: 60 })
  await loginPage.handleSendCode()
  assert.equal(loginPage.data.codeSent, true, '发送成功才显示提示')
  assert.equal(loginPage.data.cooldown, 60)
  cooldown.stop(loginPage)
  loginPage.setData({ cooldown: 0 })
  loginPage.handleEmailInput({ detail: { value: 'second@example.test' } })
  assert.equal(loginPage.data.codeSent, false, '换邮箱后清除旧提示')
  sender.sendAuthCode = () => new Promise(resolve => { finishSend = resolve })
  const oldSend = loginPage.handleSendCode()
  loginPage.handleEmailInput({ detail: { value: 'third@example.test' } })
  finishSend({ ok: true, cooldown: 60 }); await oldSend
  assert.equal(loginPage.data.codeSent, false, '旧邮箱的迟到发送结果不显示提示')
  assert.equal(loginPage.data.cooldown, 0)
  delete global.wx
  gateway.resetAuthGateway()
  console.log('登录表单通过：首次邮箱、协议、并发提交、失败重试、凭据不持久化与协议入口')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
