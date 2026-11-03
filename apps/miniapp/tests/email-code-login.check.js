const assert = require('node:assert/strict')
const { LoginViewModel } = require('../miniprogram/viewmodels/login-viewmodel.js')
async function run() {
  let input, sends = 0
  const vm = new LoginViewModel({ repository: {
    loginWithCode: async (_, value) => { input = value; return { ok: true, auth: {} } },
    sendAuthCode: async (_, value) => { assert.equal(value.purpose, 'login'); sends++; return { ok: true, cooldown: 60 } }
  } })
  vm.toggleMode(); vm.setField('email', 'student@example.test'); vm.setField('agreed', true)
  vm.setField('code', '12'); assert.equal(vm._validate().field, 'code')
  vm.setField('code', '001234'); await vm.sendCode('login'); await vm.submit()
  assert.deepEqual(input, { email: 'student@example.test', code: '001234' }); assert.equal(sends, 1)
  vm.toggleMode(); assert.equal(vm.fields.code, ''); assert.equal(vm.fields.password, '')
  console.log('邮箱验证码登录：输入校验、用途、前导零和模式切换通过')
}
run().catch(e => { console.error(e); process.exitCode = 1 })
