const assert = require('node:assert/strict')
const { LoginViewModel } = require('../miniprogram/viewmodels/login-viewmodel.js')

async function run() {
  let input, sends = 0
  const vm = new LoginViewModel({ repository: {
    loginWithEmail: async (_, value) => { input = value; return { ok: true, auth: {} } },
    sendAuthCode: async () => { sends++; return { ok: true } }
  } })
  vm.setField('email', 'student@example.test')
  vm.setField('code', '001234')
  const selected = vm.setField('email', 'qandatest001@qanda.mail').data
  assert.equal(selected.testAccount, true)
  assert.equal(selected.codeMode, false)
  assert.equal(selected.code, '')
  await vm.sendCode('login')
  assert.equal(sends, 0)
  vm.setField('password', '001234')
  assert.equal(vm._validate().field, 'password')
  vm.setField('password', 'TestLogin1234567')
  assert.equal(vm._validate().field, 'agreed')
  vm.setField('agreed', true)
  await vm.submit()
  assert.deepEqual(input, { email: 'qandatest001@qanda.mail', password: 'TestLogin1234567' })
  const normal = vm.setField('email', 'student@example.test').data
  assert.equal(normal.testAccount, false)
  assert.equal(normal.codeMode, true)
  assert.equal(normal.password, '')
  assert.equal(normal.code, '')
  assert.equal(new LoginViewModel({ email: 'QANDATEST1000@qanda.mail' }).load().data.testAccount, true)
  assert.equal(new LoginViewModel({ email: 'QANDATEST001@qanda.mail.example' }).load().data.testAccount, false)
  assert.equal(new LoginViewModel({ email: 'other@qanda.mail' }).load().data.testAccount, false)
  console.log('测试账号登录：自动识别、固定码校验、通道分流、禁发邮件和切换清理通过')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
