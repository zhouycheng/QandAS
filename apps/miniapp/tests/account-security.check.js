const assert = require('node:assert/strict')
const { AccountSecurityViewModel } = require('../miniprogram/viewmodels/account-security-viewmodel.js')
const { AccountSecurityRepository } = require('../miniprogram/repositories/account-security-repository.js')
const { LoginViewModel } = require('../miniprogram/viewmodels/login-viewmodel.js')
const { AccountViewModel } = require('../miniprogram/viewmodels/account-viewmodel.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const remote = require('../miniprogram/repositories/remote-data-repository.js')
const transport = require('../miniprogram/repositories/api-transport.js')

async function main() {
  let now = Date.parse('2026-11-02T00:00:00Z')
  const calls = []
  let failure = null
  const repo = {
    load: async () => ({ email: 'owner@example.test', wechatBound: false, version: 3 }),
    issue: async (input, key) => { calls.push(['issue', input, key]); if (failure) throw failure; return { id: 'proof', expiresAt: new Date(now + 600000).toISOString(), resendAfterSeconds: 60 } },
    verify: async (id, input) => { calls.push(['verify', id, input]); if (failure) throw failure },
    password: async (input, key) => { calls.push(['password', input, key]); if (failure) throw failure },
    email: async (input, key) => { calls.push(['email', input, key]); if (failure) throw failure },
    wechatCode: async () => { calls.push(['wx.login']); return 'single-use-code' },
    wechat: async (input, key) => { calls.push(['wechat', input, key]); if (failure) throw failure; return { version: 4 } },
    refresh: async () => calls.push(['refresh']),
    expire: () => calls.push(['expire'])
  }
  const create = mode => new AccountSecurityViewModel({ mode, repository: repo, now: () => now })
  const fixed = new AccountSecurityViewModel({ repository: { load: async () => ({ isTestAccount: true, email: 'QANDATEST001@qanda.mail' }) } })
  assert.equal((await fixed.load()).data.stage, 'test-account')
  assert.equal(await fixed.sendCode(), null)
  assert.equal(await fixed.submit(), null)
  const vm = create('email')
  assert.equal((await vm.load()).data.stage, 'verify')
  assert.equal((await vm.submit()).data.errorField, 'code')
  failure = new Error('network')
  await vm.sendCode(); await vm.sendCode()
  assert.equal(calls.at(-1)[2], calls.at(-2)[2], 'response loss retries same challenge intention')
  failure = null
  assert.equal((await vm.sendCode()).command.type, 'cooldown')
  assert.equal(await vm.sendCode(), null)
  vm.setField('code', '123456')
  failure = Object.assign(new Error('验证码无效'), { code: 'VERIFICATION_FAILED' })
  assert.equal((await vm.submit()).data.stage, 'verify', 'failed proof never opens password form')
  failure = null
  assert.equal((await vm.submit()).data.stage, 'email')
  assert.equal(Object.hasOwn(vm.fields, 'password'), false)

  const email = create('email')
  await email.load(); await email.sendCode(); email.setField('code', '123456')
  assert.equal((await email.submit()).data.stage, 'email')
  assert.equal(calls.filter(call => call[0] === 'email').length, 0, 'old email verification only opens the new email form')
  assert.equal((await email.submit()).data.stage, 'email', 'repeated confirmation cannot skip new email verification')
  assert.equal(calls.filter(call => call[0] === 'email').length, 0)
  email.setField('email', 'owner@example.test')
  assert.equal((await email.sendCode()).data.errorField, 'email')
  email.setField('email', 'new@example.test')
  await email.sendCode(); email.setField('code', '654321')
  email.challenge.email = 'other@example.test'
  assert.equal((await email.submit()).data.errorField, 'email', 'late proof for a different mailbox cannot change the account')
  email.challenge.email = 'new@example.test'
  const emailResult = await email.submit()
  assert.equal(emailResult.command.type, 'login')
  assert.equal(emailResult.command.title, '邮箱已更换，请重新登录')
  assert.equal(emailResult.command.email, 'new@example.test')
  assert.equal(emailResult.command.reason, 'email-updated')
  const payload = calls.filter(call => call[0] === 'email').at(-1)[1]
  assert.equal(payload.oldCode, '123456'); assert.equal(payload.newCode, '654321')

  const returning = new LoginViewModel({ email: emailResult.command.email, returnReason: emailResult.command.reason })
  assert.equal(returning.load().data.email, 'new@example.test')
  assert.equal(returning.load().data.password, '')
  assert.equal(returning.load().data.agreed, false)
  assert.equal(returning.load().data.loginNotice, '邮箱已更换，请使用新邮箱验证码登录。')
  returning.setField('email', 'edited@example.test')
  assert.equal(returning.load().data.email, 'edited@example.test', 'later page shows preserve user edits')
  const invalidPrefill = new LoginViewModel({ email: '<invalid>', returnReason: 'arbitrary text' })
  assert.equal(invalidPrefill.load().data.email, '')
  assert.equal(invalidPrefill.load().data.loginNotice, '')

  const expired = create('email')
  await expired.load(); await expired.sendCode(); expired.setField('code', '123456'); await expired.submit()
  now += 601000
  expired.setField('email', 'expiry@example.test'); await expired.sendCode(); expired.setField('code', '123456')
  assert.equal((await expired.submit()).data.stage, 'verify')

  const noEmailRepo = Object.assign({}, repo, { load: async () => ({ version: 1, email: null,  }) })
  const noEmail = new AccountSecurityViewModel({ repository: noEmailRepo, mode: 'password' })
  assert.equal((await noEmail.load()).data.stage, 'email')
  const bind = new AccountSecurityViewModel({ repository: noEmailRepo, mode: 'email', now: () => now })
  await bind.load(); bind.setField('email', 'first@example.test'); await bind.sendCode()
  assert.equal(calls.at(-1)[1].purpose, 'BIND_EMAIL')
  bind.setField('email', 'changed@example.test')
  assert.equal(bind.challenge, null, 'proof is tied to exact email')

  let accountProfile = { nickname: '账户名字', wechatBound: false, version: 3 }
  let accountToken = 'owner-token'
  const security = Object.assign({}, repo, {
    load: async () => accountProfile,
    wechat: async (input, key) => { calls.push(['wechat', input, key]); if (failure) throw failure; accountProfile = Object.assign({}, accountProfile, { wechatBound: true, version: 4 }); return { version: 4 } }
  })
  const account = new AccountViewModel({ securityRepository: security, repository: {
    getAuth: () => ({ provider: 'email', userId: 'owner', token: accountToken, nickname: accountProfile.nickname, profile: accountProfile }),
    isRemoteEnabled: () => true
  } })
  account.load()
  account.setField('nickname', '尚未保存的昵称')
  assert.equal(account.tapWechat().command.type, 'confirm-wechat-binding')
  failure = new Error('response lost')
  await assert.rejects(account.bindWechat(), /response lost/)
  await assert.rejects(account.bindWechat(), /response lost/)
  assert.equal(calls.at(-1)[2], calls.at(-2)[2])
  assert.equal(calls.filter(call => call[0] === 'wx.login').length, 1)
  failure = null
  assert.equal((await account.bindWechat()).command.title, '微信已绑定')
  assert.deepEqual(Object.keys(calls.filter(call => call[0] === 'wechat').at(-1)[1]).sort(), ['code', 'expectedVersion'])
  assert.equal(account.readProfile().wechatStatus, '已绑定')
  assert.equal(account.tapWechat(), null)
  assert.equal(account.pending.nickname, '尚未保存的昵称', 'binding preserves the profile draft')

  const avatar = 'data:image/png;base64,' + 'A'.repeat(1024)
  const savedRemoteProfile = remote.saveProfile
  let profilePayload
  remote.saveProfile = async (_storage, patch) => { profilePayload = patch; accountProfile = Object.assign({}, accountProfile, { nickname: patch.nickname, avatarUrl: patch.avatar }) }
  account.setField('nickname', '微信选择的名字')
  account.setField('avatarUrl', avatar)
  await account.save()
  assert.equal(profilePayload.nickname, '微信选择的名字')
  assert.equal(profilePayload.avatar, avatar, 'native avatar belongs to the account profile')
  assert.equal(account.readProfile().avatarUrl, avatar)
  remote.saveProfile = savedRemoteProfile
  assert.equal(require('../miniprogram/utils/auth-session.js').normalizeAuth({ provider: 'email', userId: 'owner', token: 'owner-token', avatarUrl: avatar }).avatarUrl, avatar, 'avatar payloads are not truncated to URL length')

  let pageDefinition
  global.Page = value => { pageDefinition = value }
  require('../miniprogram/page/account/index.js')
  delete global.Page
  const page = Object.assign({}, pageDefinition, { viewModel: account, data: AccountViewModel.getInitialData(),
    setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() } })
  page.handleUseWechatNickname()
  assert.equal(page.data.nicknameFocus, true)
  let avatarRead
  global.wx = { compressImage: options => options.success({ tempFilePath: 'compressed-avatar' }),
    getFileSystemManager: () => ({ readFile: options => { avatarRead = options } }) }
  page.handleChooseAvatar({ detail: { avatarUrl: 'native-avatar' } })
  assert.equal(page.data.avatarPreparing, true)
  accountToken = 'other-account-token'
  avatarRead.success({ data: 'iVBORw0KGgoAAA==' })
  assert.equal(account.pending.avatarUrl, avatar, 'late image reads cannot alter another account')
  delete global.wx

  const map = new Map()
  const storage = { get: key => map.get(key), set: (key, value) => map.set(key, value), remove: key => map.delete(key) }
  auth.saveAuth(storage, { provider: 'email', userId: 'one', token: 'one-token' })
  const real = new AccountSecurityRepository(storage)
  let resolve
  remote.refreshProfile = () => new Promise(done => { resolve = done })
  const pending = real.load()
  auth.saveAuth(storage, { provider: 'email', userId: 'two', token: 'two-token' })
  resolve({ ok: true, data: { id: 'one' } })
  await assert.rejects(pending, error => error.code === 'SESSION_CHANGED')
  real.expire()
  assert.equal(auth.getAuth(storage).userId, 'two', 'late old operation cannot expire new account')

  let unauthorized = 0
  transport.configure({ baseUrl: 'https://example.test', tokenProvider: () => 'token', onUnauthorized: () => { unauthorized += 1 } })
  global.wx = { request: options => { options.success({ statusCode: 401, data: { code: 'WECHAT_CODE_INVALID' } }); return {} } }
  await transport.request('PUT', '/me/wechat-binding', {})
  assert.equal(unauthorized, 0, 'WeChat code expiry does not expire login session')
  global.wx.request = options => { options.success({ statusCode: 401, data: { code: 'UNAUTHENTICATED' } }); return {} }
  await transport.request('GET', '/me', {})
  assert.equal(unauthorized, 1)
  delete global.wx
  console.log('PASS account security: verified steps, two email proofs, retry, expiry, WeChat and identity isolation')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
