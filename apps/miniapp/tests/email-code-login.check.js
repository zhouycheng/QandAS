const assert = require('node:assert/strict')
const { LoginViewModel } = require('../miniprogram/viewmodels/login-viewmodel.js')
async function run() {
  let input, sends = 0
  const vm = new LoginViewModel({ repository: {
    loginWithCode: async (_, value) => { input = value; return { ok: true, auth: {} } },
    sendAuthCode: async (_, value) => { assert.equal(value.purpose, 'login'); sends++; return { ok: true, cooldown: 60 } }
  } })
  vm.setField('email', 'student@example.test'); vm.toggleAgreed()
  vm.setField('code', '12'); assert.equal(vm._validate().field, 'code')
  vm.setField('code', '001234'); await vm.sendCode('login'); await vm.submit()
  assert.deepEqual(input, { email: 'student@example.test', code: '001234' }); assert.equal(sends, 1)
  console.log('邮箱验证码登录：输入校验、用途和前导零通过')
}
run().catch(e => { console.error(e); process.exitCode = 1 })
