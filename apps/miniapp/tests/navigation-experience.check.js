const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const script = require('node:vm')
const root = path.resolve(__dirname, '../miniprogram')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const app = JSON.parse(read('app.json'))
const tabs = new Set(app.tabBar.list.map(tab => tab.pagePath))
const head = read('templates/practice-head.wxml')
const practice = read('page/practice/index.wxml')

assert.equal(app.usingComponents['page-header'], '/components/page-header/index')
for (const route of app.pages) {
  const config = JSON.parse(read(route + '.json'))
  assert.equal(config.navigationStyle || app.window.navigationStyle, 'custom', route + ' 导航随页面绘制')
  if (!tabs.has(route)) {
    const content = read(route + '.wxml').replace(/<include src="..\/..\/templates\/practice-head.wxml"\s*\/>/g, head)
    assert.equal((content.match(/<page-header\b/g) || []).length, 1, route + ' 只有一处顶部安全区与返回入口')
  }
}

const { getInitialHomeHeaderData } = require('../miniprogram/utils/home-header.js')
for (const [windowInfo, menu] of [
  [{ statusBarHeight: 44, windowWidth: 375 }, { top: 50, height: 32, left: 278 }],
  [{ statusBarHeight: 24, windowWidth: 393 }, { top: 32, height: 32, left: 286 }],
  [{ statusBarHeight: 0, windowWidth: 320 }, { top: 4, height: 32, left: 224 }]
]) {
  const value = getInitialHomeHeaderData(windowInfo, menu)
  assert.equal(value.homeStatusBarHeight, windowInfo.statusBarHeight)
  assert.equal(value.homeNavigationBarHeight, (menu.top - windowInfo.statusBarHeight) * 2 + menu.height)
  assert.equal(windowInfo.windowWidth - value.homeNavigationRight, menu.left - 8, '标题在胶囊左侧保留间距')
  assert.ok(windowInfo.windowWidth - value.homeNavigationRight - 44 > 0, '小屏保留标题宽度')
}
assert.equal(getInitialHomeHeaderData({}, { top: 0, height: 0, left: 0 }).homeNavigationBarHeight, 44)
assert.equal(getInitialHomeHeaderData().homeNavigationRight, 104)

let definition, back, fallback, backCalls = 0
global.Component = value => { definition = value }
global.wx = {
  getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 375 }),
  getMenuButtonBoundingClientRect: () => ({ top: 50, height: 32, left: 278 }),
  navigateBack: input => { back = input; backCalls++ },
  switchTab: input => { fallback = input.url; input.complete({}) }
}
require('../miniprogram/components/page-header/index.js')
const component = Object.assign({}, definition.methods, {
  data: {},
  setData(patch) { Object.assign(this.data, patch) }
})
definition.lifetimes.attached.call(component)
assert.equal(component.data.homeStatusBarHeight, 44)
component.goBack()
assert.ok(back)
component.goBack()
assert.equal(backCalls, 1, '连续点击返回只执行一次原生路由')
assert.equal(fallback, undefined, '返回沿用原生页面栈')
back.fail({})
back.complete({})
assert.equal(fallback, '/page/subject-list/index', '分享入口无前页时回首页')
assert.equal(component.navigatingBack, false)
global.wx.getWindowInfo = () => ({ statusBarHeight: 24, windowWidth: 393 })
global.wx.getMenuButtonBoundingClientRect = () => ({ top: 32, height: 32, left: 286 })
definition.pageLifetimes.resize.call(component)
assert.equal(component.data.homeNavigationBarHeight, 48, '窗口变化重新计算安全区')

const { OnlinePractice } = require('../miniprogram/repositories/online-practice.js')
const runtime = new OnlinePractice({})
let draft
runtime.queue = { get: () => draft }
const note = practice.match(/<view\b[^>]*wx:if="{{([^}]+)}}"[^>]*aria-live="polite"/)[1]
const visible = () => !!script.runInNewContext(note, runtime.saveStatus('session'))
assert.equal(visible(), false, '已保存不占行')
draft = { sequence: 1, acknowledgedSequence: 0 }
assert.equal(visible(), false, '常规排队不占行')
draft.pending = { serverAccepted: true }
assert.equal(visible(), false, '服务端处理中不占行')
draft.failures = 1
draft.reason = '网络连接失败，请重试'
assert.equal(visible(), true, '同步失败保留操作提示')
draft.paused = 'auth'
draft.reason = '请先登录'
assert.equal(visible(), true, '需要登录时保留提示')
runtime.saveErrors.session = true
assert.equal(visible(), true, '本机写入失败保留提示')
assert.match(practice, /bindtap="retrySync"/)
assert.match(practice, /wx:if="{{submitError}}"/)
assert.match(practice, /bindtap="retrySubmit"/)
assert.match(head, /isCompleted \? '练习结果'/)
console.log(`导航体验自检通过：${app.pages.length} 个页面配置、${app.pages.length - tabs.size} 个二级页、安全区、原生返回和同步异常提示`)
