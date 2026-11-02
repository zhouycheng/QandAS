const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { AboutViewModel } = require('../miniprogram/viewmodels/about-viewmodel.js')
const content = require('../miniprogram/data/about.js')

assert.deepEqual(content.developers.map(item => item.username), ['zhouycheng', 'JiangfengPang', 'Currycyber', 'hopehoudini'])
const model = new AboutViewModel()
for (const member of content.developers) {
  assert.ok(fs.statSync(path.join(__dirname, '../miniprogram', member.avatar)).size > 0)
  assert.equal(model.copyDeveloper(member.username).command.text, member.url)
}
assert.equal(model.copyDeveloper('unknown'), null)
const markup = fs.readFileSync(path.join(__dirname, '../miniprogram/page/about/index.wxml'), 'utf8')
assert.ok(markup.includes('关于这个应用') && markup.includes('开发团队'))
assert.ok(!markup.includes('{{item.username}}</text>'), '团队仅显示头像')

let definition, copied, toast, copyResult = 'success'
global.Page = value => { definition = value }
global.getApp = () => ({ globalData: { version: '1.0.0' } })
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { version: '1.0.8' } }),
  setClipboardData(input) { copied = input.data; input[copyResult]() },
  showToast(input) { toast = input.title }
}
require('../miniprogram/page/about/index.js')
const page = Object.assign({}, definition, { data: {}, setData(patch) { Object.assign(this.data, patch) } })
definition.onLoad.call(page)
assert.equal(page.viewModel.version, '1.0.8', '正式包使用微信提供的版本号')
global.wx.getAccountInfoSync = () => ({ miniProgram: { version: '' } })
definition.onLoad.call(page)
assert.equal(page.viewModel.version, '1.0.0', '开发包回落应用版本')
global.wx.getAccountInfoSync = () => { throw new Error('unsupported') }
definition.onLoad.call(page)
assert.equal(page.viewModel.version, '1.0.0')
page.handleDeveloperTap({ currentTarget: { dataset: { username: 'Currycyber' } } })
assert.equal(copied, 'https://github.com/Currycyber')
assert.equal(toast, 'GitHub 地址已复制')
copyResult = 'fail'
page.handleDeveloperTap({ currentTarget: { dataset: { username: 'hopehoudini' } } })
assert.equal(toast, '复制失败，请重试')
console.log('关于页自检通过：应用包版本、四位开发者本地头像、复制成功与失败、应用说明')
