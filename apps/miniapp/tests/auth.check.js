/** 登录身份、失败处理和页面契约自检。 */
const fs = require('fs')
const path = require('path')

const MINIPROGRAM = path.resolve(__dirname, '../miniprogram')
const authSession = require(path.join(MINIPROGRAM, 'utils/auth-session.js'))
const authRepository = require(path.join(MINIPROGRAM, 'repositories/auth-repository.js'))
const authGateway = require(path.join(MINIPROGRAM, 'repositories/auth-gateway.js'))
const httpGateway = require(path.join(MINIPROGRAM, 'repositories/http-gateway.js'))
const { LoginViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/login-viewmodel.js'))
const { SettingsViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/settings-viewmodel.js'))
const { MyViewModel } = require(path.join(MINIPROGRAM, 'viewmodels/my-viewmodel.js'))

const results = []

function assert(name, condition, detail) {
  results.push({
    name,
    passed: !!condition,
    detail: condition ? '' : detail || ''
  })
}

function createMemoryStorage(initial) {
  const map = Object.assign({}, initial || {})

  return {
    get(key) {
      return map[key] === undefined ? null : map[key]
    },

    set(key, value) {
      map[key] = value
    },

    remove(key) {
      delete map[key]
    },

    keys() {
      return Object.keys(map)
    },

    raw: map
  }
}

function readFile(relativePath) {
  return fs.readFileSync(path.join(MINIPROGRAM, relativePath), 'utf8')
}

// ---------- 一、身份规则 ----------
function checkSessionRules() {
  const normalize = authSession.normalizeAuth

  assert('身份 - 空值判未登录', normalize(null).loggedIn === false)
  assert('身份 - 字符串脏数据判未登录', normalize('qandaAuth').loggedIn === false)
  assert('身份 - 数组脏数据判未登录', normalize([]).loggedIn === false)
  assert('身份 - 只有 provider 没有 id 判未登录', normalize({ provider: 'wechat', userId: '' }).loggedIn === false)
  assert('身份 - 未知 provider 判未登录', normalize({ provider: 'qq', userId: 'u1' }).loggedIn === false)
  assert('身份 - 存储里 loggedIn 为 true 也不能单独作数',
    normalize({ loggedIn: true, provider: '', userId: '' }).loggedIn === false)
  assert('身份 - 有 provider + userId 才算已登录',
    normalize({ provider: 'wechat', userId: 'u1', token: 'tk' }).loggedIn === true)

  const devAuth = normalize({ provider: 'dev', userId: 'dev_old', token: 'old' })
  assert('身份 - 旧本地身份保持未登录', !devAuth.loggedIn)

  const wechat = authSession.buildWechatAuth(
    { userId: 'user-9', openId: 'open-9', token: 'tk', nickname: '佳乐' },
    1758000000000
  )

  assert('身份 - 使用统一用户标识和令牌',
    wechat.userId === 'user-9' && wechat.openId === 'open-9' && wechat.token === 'tk',
    JSON.stringify(wechat))
  assert('身份 - 真登录 provider 是 wechat', wechat.provider === 'wechat')

  const view = authSession.describeAuth(wechat)

  assert('身份 - 有昵称时显示昵称', view.displayName === '佳乐', view.displayName)
  assert('身份 - 无昵称时显示「微信用户」',
    authSession.describeAuth(authSession.buildWechatAuth({ userId: 'u', token: 'tk' })).displayName === '微信用户')
  assert('身份 - 未登录显示「未登录」', authSession.describeAuth(null).displayName === '未登录')
  assert('身份 - 状态标签取来源名', view.accountTag === '微信登录', view.accountTag)

  assert('身份 - 未登录改资料不产生身份', authSession.applyProfile(null, { nickname: 'x' }).loggedIn === false)
  assert('身份 - 已登录改昵称生效',
    authSession.applyProfile(wechat, { nickname: 'curry' }).nickname === 'curry')
  assert('身份 - 昵称超长被截断',
    authSession.applyProfile(wechat, { nickname: 'a'.repeat(80) }).nickname.length ===
      authSession.NICKNAME_MAX_LENGTH)

  assert('身份 - 登录时间为空时不显示 1970', authSession.formatLoginTime(0) === '')
  assert('身份 - 登录时间有值时非空', authSession.formatLoginTime(1758000000000, 1758000000000).length > 0)

  assert('身份 - 登录和未登录说明各不相同',
    new Set([
      authSession.getAuthHint(null),
      authSession.getAuthHint(wechat)
    ]).size === 2)
}

// ---------- 二、登录仓储 ----------
async function checkRepository() {
  const storage = createMemoryStorage()
  const noCode = await authRepository.login(storage, { codeProvider: (done) => done('') })
  assert('仓储 - 缺少微信凭证时保持未登录', !noCode.ok && !noCode.auth.loggedIn)
  authGateway.setAuthGateway({ login: () => ({ ok: false, unavailable: true, reason: '断网' }) })
  const offline = await authRepository.login(storage, { codeProvider: (done) => done('code') })
  assert('仓储 - 断网时保留失败原因', !offline.ok && offline.reason === '断网')
  assert('仓储 - 断网不保存身份', storage.get(authSession.AUTH_STORAGE_KEY) === null)
  authGateway.setAuthGateway({ login: () => Promise.resolve({ ok: true, userId: 'u1', token: 'tk1' }) })
  const online = await authRepository.login(storage, { codeProvider: (done) => done('code') })
  assert('仓储 - 服务端身份落盘', online.ok && authRepository.getAuth(storage).userId === 'u1')
  assert('仓储 - 资料缓存保留身份', authRepository.updateProfile(storage, { nickname: '佳乐' }).auth.nickname === '佳乐')
  authRepository.logout(storage)
  assert('仓储 - 退出后未登录', !authRepository.getAuth(storage).loggedIn)
  authGateway.resetAuthGateway()
}

// ---------- 三、HTTP 网关登录接口 ----------
async function checkHttpGateway() {
  const originalWx = global.wx
  httpGateway.configure({ baseUrl: 'https://api.example.com' })
  const calls = []
  global.wx = { request(options) {
    calls.push(options)
    options.success({ statusCode: 200, data: options.url.endsWith('/me') ? { id: 'u9', nickname: '昵称' } : { accessToken: 'tk9' } })
  } }
  const result = await httpGateway.login('code9')
  assert('网关 - 微信 code 交给 v1 会话接口', calls[0].url.endsWith('/api/v1/auth/wechat-sessions') && calls[0].data.code === 'code9')
  assert('网关 - 用令牌读取统一用户资料', calls[1].header.Authorization === 'Bearer tk9' && result.userId === 'u9')
  global.wx = { request(options) { options.success({ statusCode: 200, data: {} }) } }
  assert('网关 - 缺少身份时返回失败', !(await httpGateway.login('code')).ok)
  httpGateway.configure({ baseUrl: '' })
  assert('网关 - 未配置域名时返回失败', !(await httpGateway.login('code')).ok)
  if (originalWx === undefined) delete global.wx
  else global.wx = originalWx
}

// ---------- 四、登录页 ViewModel（设计稿 763:567：邮箱密码为主，微信登录为辅） ----------
async function checkLoginViewModel() {
  const storage = createMemoryStorage()
  const vm = new LoginViewModel({ storage })
  vm.setField('email', 'new@example.test'); vm.setField('code', '123456'); vm.toggleAgreed()
  authGateway.setAuthGateway({ loginByCode: () => ({ ok: false, reason: '服务不可用' }) })
  assert('登录失败保留未登录', (await vm.submit()).command.type === 'toast' && !authRepository.getAuth(storage).loggedIn)
  authGateway.setAuthGateway({ loginByCode: () => ({ ok: true, userId: 'u9', token: 'tk9' }) })
  assert('邮箱验证码成功直接返回', (await vm.submit()).command.type === 'back')
  assert('验证码不保存', !JSON.stringify(storage.raw).includes('123456'))
  authGateway.setAuthGateway({ login: () => ({ ok: true, userId: 'wx9', token: 'wx-token' }) })
  const wechat = new LoginViewModel({ storage: createMemoryStorage() })
  assert('微信登录需要协议', (await wechat.wechatLogin()).command.type === 'toast')
  global.wx = { login: input => input.success({ code: 'fresh-code' }) }
  wechat.toggleAgreed()
  assert('微信首次登录直接返回', (await wechat.wechatLogin()).command.type === 'back')
  delete global.wx
  authGateway.resetAuthGateway()
}

// ---------- 五、设置页与我的页 ----------
async function checkEntryPages() {
  const storage = createMemoryStorage()
  const settings = new SettingsViewModel({ storage })

  // 账号统一通过「我的 → 账号管理」维护。
  assert('设置 - 账户分组已迁出（不再有 accountActions）',
    settings.load().data.accountActions === undefined)
  assert('设置 - 不再提供账户动作入口', typeof settings.openAccountAction === 'undefined')

  // 我的页
  const myStorage = createMemoryStorage()
  const my = new MyViewModel({ storage: myStorage })

  assert('我的 - 未登录时资料卡引导登录', my.load().data.auth.displayName === '点击登录',
    my.load().data.auth.displayName)
  assert('我的 - 未登录标签是未登录', my.load().data.auth.accountTag === '未登录')
  assert('我的 - 未登录点账号管理去登录页',
    my.tapRow('account').command.url === '/page/login/index',
    JSON.stringify(my.tapRow('account')))
  assert('我的 - 未登录点邮箱提醒先引导登录',
    my.tapRow('account-deletion').command.url === '/page/login/index',
    JSON.stringify(my.tapRow('account-deletion')))

  authGateway.setAuthGateway({
    name: 'fake',
    login: () => ({ ok: true, userId: 'u-2', token: 'tk2', openId: 'o-2', nickname: 'curry' })
  })
  await authRepository.login(myStorage, { codeProvider: (done) => done('code-1') })
  authGateway.resetAuthGateway()

  const myAfter = my.load()

  assert('我的 - 登录后资料卡显示昵称', myAfter.data.auth.displayName === 'curry', myAfter.data.auth.displayName)
  assert('我的 - 登录后标签是微信登录', myAfter.data.auth.accountTag === '微信登录')
  assert('我的 - 登录后账号管理进账号页',
    my.tapRow('account').command.url === '/page/account/index',
    JSON.stringify(my.tapRow('account')))
  assert('我的 - 登录后邮箱提醒可进入',
    my.tapRow('account-deletion').command.url === '/page/account-deletion/index',
    JSON.stringify(my.tapRow('account-deletion')))

  const logout = my.logout()

  assert('我的 - 退出登录回传未登录视图', logout.data.auth.loggedIn === false)
  assert('我的 - 退出登录有提示', logout.command.title === '已退出登录')
}

// ---------- 六、页面契约（静态） ----------
function checkStaticContract() {
  const appConfig = JSON.parse(readFile('app.json'))

  assert('页面 - 登录页已注册', appConfig.pages.indexOf('page/login/index') >= 0)

  const files = ['index.js', 'index.json', 'index.wxml', 'index.wxss']

  assert('页面 - 登录页四个文件齐全',
    files.every((file) => fs.existsSync(path.join(MINIPROGRAM, 'page/login', file))))

  const loginJs = readFile('page/login/index.js')
  const loginWxml = readFile('page/login/index.wxml')

  // 改版后登录页是纯认证页（设计稿 763:567），不再承担头像昵称编辑
  assert('页面 - 登录按钮处理函数已定义', loginJs.indexOf('handleLoginTap()') >= 0)
  assert('页面 - 微信登录处理函数已定义', loginJs.indexOf('handleWechatTap()') >= 0)
  assert('页面 - 协议入口可打开', loginJs.includes('handleLegal(event)'))
  assert('页面 - 验证码发送处理函数已定义', loginJs.includes('handleSendCode()'))
  assert('页面 - 登录页注册原生 Page 配置', /Page\(withPageLifecycle\(\s*\{/.test(loginJs))

  // 输入框不再做受控回写：回写 value 会让真机光标跳到末尾
  assert('页面 - 输入不反写 value', loginJs.indexOf('value:') < 0)

  const allJs = []
  const walk = (dir) => {
    fs.readdirSync(dir).forEach((name) => {
      const full = path.join(dir, name)

      if (fs.statSync(full).isDirectory()) {
        walk(full)
      } else if (full.endsWith('.js') || full.endsWith('.wxml')) {
        allJs.push(full)
      }
    })
  }
  walk(MINIPROGRAM)

  // 只匹配「调用」形态：注释里解释「getUserProfile 已废弃」不该被判成违规
  const deprecated = allJs.filter((file) => {
    const src = fs.readFileSync(file, 'utf8')

    return /wx\.getUserProfile|wx\.getUserInfo|getUserProfile\s*\(|getUserInfo\s*\(|open-type="getUserInfo"/.test(src)
  })

  assert('页面 - 全仓不使用已废弃的 getUserProfile / getUserInfo',
    deprecated.length === 0, deprecated.join(', '))

  const myJs = readFile('page/my/index.js')
  const myWxml = readFile('page/my/index.wxml')

  assert('页面 - 我的页资料头是登录 / 账号入口', myWxml.indexOf('handleProfileTap') >= 0)
  assert('页面 - 我的页资料头处理函数有定义', myJs.indexOf('handleProfileTap()') >= 0)
  assert('页面 - 我的页状态标签跟随登录态', myWxml.indexOf('{{auth.accountTag}}') >= 0)

  // 账号分组迁到独立页面后，脱敏邮箱与密码状态在这一页
  const accountWxml = readFile('page/account/index.wxml')
  const accountJs = readFile('page/account/index.js')

  assert('页面 - 账号管理页显示脱敏邮箱', accountWxml.indexOf('{{profile.emailMasked') >= 0)
  assert('页面 - 账号管理页可改头像（chooseAvatar）',
    accountWxml.indexOf('open-type="chooseAvatar"') >= 0)
  assert('页面 - 账号管理页头像读取为可保存的图片内容',
    accountJs.includes('compressImage') && accountJs.includes("encoding: 'base64'") && accountJs.includes("setField('avatarUrl', avatar)"))
  assert('页面 - 账号管理页保存入口已定义', accountJs.indexOf('handleSaveTap()') >= 0)

  const settingsWxml = readFile('page/settings/index.wxml')

  assert('页面 - 设置页不再放账户分组', settingsWxml.indexOf('accountActions') < 0)
  assert('页面 - 退出登录独立显示且仅登录后可见',
    /<view\s+wx:if="\{\{auth.loggedIn\}\}"[^>]*bindtap="confirmLogout"/.test(readFile('page/my/index.wxml')))

  const loginWxss = readFile('page/login/index.wxss')

  // 三个认证页必须共用同一份尺寸来源，否则三个页面会慢慢长歪
  assert('页面 - 登录页引入公用认证样式', loginWxss.indexOf('styles/auth-form.wxss') >= 0)
  // 从登录页返回后，两个入口页都得重新读一次身份，否则标签还停在旧状态
  assert('页面 - 设置页返回时刷新登录态', readFile('page/settings/index.js').indexOf('onShow()') >= 0)
  assert('页面 - 我的页返回时刷新登录态', readFile('page/my/index.js').indexOf('onShow()') >= 0)
}

async function main() {
  checkSessionRules()
  await checkRepository()
  await checkHttpGateway()
  await checkLoginViewModel()
  await checkEntryPages()
  checkStaticContract()
}

main().then(() => {
  const failed = results.filter((item) => !item.passed)
  const width = Math.max(...results.map((item) => item.name.length))

  console.log('\n=== 微信登录自检 ===\n')

  results.forEach((item) => {
    console.log(`${item.passed ? '  ✓' : '  ✗'} ${item.name.padEnd(width, ' ')}  ${item.passed ? '' : item.detail}`)
  })

  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)

  if (failed.length > 0) {
    process.exit(1)
  }
}, (error) => {
  console.error('自检脚本异常：', error)
  process.exit(1)
})
