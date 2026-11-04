/* 自定义 tabBar 的配置、导航、选中态和页面留白检查。 */
const fs = require('fs')
const path = require('path')

const MINIPROGRAM = path.resolve(__dirname, '../miniprogram')
const read = (relative) => fs.readFileSync(path.join(MINIPROGRAM, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))

/**
 * 读 wxss 并把 @import 的内容就地展开。
 * 页面把公共尺寸抽到 styles/*.wxss 之后，只读页面文件会漏掉真正的留白值。
 */
function readWithImports(relative, depth) {
  const source = read(relative)
  const level = Number(depth) || 0

  if (level > 3) {
    return source
  }

  return source.replace(/@import\s+"([^"]+)";/g, (whole, target) => {
    const resolved = path.relative(MINIPROGRAM, path.resolve(path.join(MINIPROGRAM, path.dirname(relative)), target))

    try {
      return readWithImports(resolved, level + 1)
    } catch (error) {
      return ''
    }
  })
}

const tabBarJs = read('custom-tab-bar/index.js')
const tabBarWxml = read('custom-tab-bar/index.wxml')
const tabBarWxss = read('custom-tab-bar/index.wxss')
const appJson = readJson('app.json')

const results = []

function assert(name, condition, detail) {
  results.push({ name, passed: !!condition, detail: condition ? '' : detail || '' })
}

// ---------- 一、配置 ----------

function checkConfig() {
  const tabBar = appJson.tabBar || {}

  assert('配置 - app.json 声明 custom:true', tabBar.custom === true)
  assert('配置 - 仍保留 4 个 tab 的 list', Array.isArray(tabBar.list) && tabBar.list.length === 4,
    `实际 ${tabBar.list ? tabBar.list.length : 0} 个`)

  const pagePaths = appJson.pages
  const notRegistered = tabBar.list.filter((item) => pagePaths.indexOf(item.pagePath) < 0)

  assert('配置 - 所有 tab 页都在 pages 中注册', notRegistered.length === 0,
    notRegistered.map((item) => item.pagePath).join(', '))

  const missingIcons = tabBar.list.filter((item) =>
    !fs.existsSync(path.join(MINIPROGRAM, item.iconPath)) ||
    !fs.existsSync(path.join(MINIPROGRAM, item.selectedIconPath)))

  assert('配置 - 图标文件都真实存在', missingIcons.length === 0,
    missingIcons.map((item) => item.iconPath).join(', '))

  // custom-tab-bar 必须四件套齐全且放在小程序根目录（不在 miniprogram 子目录下）
  assert('配置 - custom-tab-bar 位于小程序根目录',
    fs.existsSync(path.join(MINIPROGRAM, 'custom-tab-bar/index.js')))
  ;['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    assert(`配置 - custom-tab-bar/index.${ext} 存在`,
      fs.existsSync(path.join(MINIPROGRAM, `custom-tab-bar/index.${ext}`)))
  })

  assert('配置 - 组件开启样式共享（才能吃到 app.wxss 的通用类）',
    tabBarJs.indexOf('styleIsolation') >= 0)
}

// ---------- 二、选中态同步（最易漏） ----------

function checkSelectionSync() {
  const tabPaths = appJson.tabBar.list.map((item) => item.pagePath)
  const notSynced = []

  tabPaths.forEach((pagePath) => {
    // app.json 里的 'page/subject-list/index' 指的就是 page/subject-list/index.js，
    // 不是 page/subject-list/index/index.js —— 拼错会全部误报「缺少 index.js」
    const jsPath = path.join(MINIPROGRAM, `${pagePath}.js`)

    if (!fs.existsSync(jsPath)) {
      notSynced.push(`${pagePath} 缺少 index.js`)
      return
    }

    const source = fs.readFileSync(jsPath, 'utf8')
    const withoutSlash = pagePath.replace(/^\//, '')

    // 三个条件缺一不可：onShow 里调、调的是 syncTabBar、路由参数与自己在 list 里的路径一致
    const hasOnShow = /\bonShow\s*\(/.test(source)
    const getsTabBar = /getTabBar\(\)/.test(source)
    const setsRoute = source.indexOf(`'${withoutSlash}'`) >= 0 || source.indexOf(`"${withoutSlash}"`) >= 0

    if (!hasOnShow || !getsTabBar || !setsRoute) {
      notSynced.push(`${pagePath}（onShow:${hasOnShow} getTabBar:${getsTabBar} route:${setsRoute}）`)
    }
  })

  assert('选中态 - 4 个 tab 页都在 onShow 同步底栏', notSynced.length === 0, notSynced.join(' | '))

  assert('选中态 - 组件暴露 setSelected', /\bsetSelected\s*\([^)\n]*\)\s*\{/.test(tabBarJs))
  assert('选中态 - 组件在 attached 时先同步一次', /attached\(\)/.test(tabBarJs))

  // findTabIndexByRoute 要能同时吃 'page/xx/index' 与 '/page/xx/index'
  assert('选中态 - 路由匹配兼容有无前导斜杠',
    tabBarJs.indexOf("charAt(0) === '/'") >= 0)
  assert('选中态 - 路由匹配忽略 query 参数', tabBarJs.indexOf("split('?')[0]") >= 0)
  assert('选中态 - 重复点击当前 tab 不重复 switchTab',
    /index === this\.data\.selected[\s\S]{0,160}?return/.test(tabBarJs))
}

// ---------- 二·补、底部留白（custom 最容易漏的一条） ----------

/**
 * 原生 tabBar 由系统预留底部空间，页面写 100vh / 小 padding 都没事。
 * 改成 custom 之后底栏变成页面内的 fixed 组件，**不再预留任何空间** ——
 * 这一条只有改 custom 才会踩，所以放在这里而不是各页面自己的测试里。
 */
function checkBottomSpace() {
  // 与 custom-tab-bar/index.wxss 的 .tabbar-wrap height 对应：
  // 底栏整体 232rpx + 40rpx 呼吸位。改底栏尺寸必须同步这里和四个页面，否则内容会被压住。
  // 底栏在 2026-10-27 整体下移 24rpx（胶囊离底 40→16），实际需要的高度反而变小了，
  // 预留值维持 272rpx 不动 —— 多留 60rpx 只会让内容更早结束，不会压住任何东西。
  const reserved = 272

  assert('留白 - tabBar 组件自身声明了高度',
    /\.tabbar-wrap\s*\{[^}]*height:\s*(\d+)rpx/.test(tabBarWxss))

  const wrapHeight = Number((tabBarWxss.match(/\.tabbar-wrap\s*\{[^}]*height:\s*(\d+)rpx/) || [])[1] || 0)
  assert('留白 - tabBar 高度不超过预留值', wrapHeight > 0 && wrapHeight <= reserved,
    `实际 ${wrapHeight}rpx，页面预留 ${reserved}rpx`)

  // 通栏滚动的页面：靠根容器 padding 让位
  // stats 用根 padding；my 改版后把让位放在底部协议链接上（设计稿 781:1922
  // 的内容区是白底通栏，根容器不再有内边距），所以这里连 @import 一起读。
  ;['stats', 'my'].forEach((name) => {
    const wxss = readWithImports(`page/${name}/index.wxss`)
    const matched = wxss.match(/\.[a-z-]*page\s*\{[^}]*padding:\s*[^;}]*?(\d+)rpx\s*;/)
    const padded = matched ? Number(matched[1]) : 0
    const bottoms = (wxss.match(/padding-bottom:\s*(\d+)rpx/g) || [])
      .map((line) => Number((line.match(/(\d+)rpx/) || [])[1] || 0))
    const bottom = Math.max(padded, ...(bottoms.length ? bottoms : [0]))

    assert(`留白 - ${name} 页底部预留 ≥ ${reserved}rpx`, bottom >= reserved, `实际 ${bottom}rpx`)
  })

  // 两栏背景铺满，末尾内容可滚动到悬浮底栏上方。
  const bankWxss = read('page/bank-detail/index.wxss')

  assert('背景 - 题库两栏铺满视口', /\.bank-detail-page\s*\{[^}]*height:\s*100vh/.test(bankWxss))
  ;['rail-inner', 'panel-inner'].forEach(name => {
    assert(`留白 - ${name} 末尾为底栏预留可滚动空间`,
      new RegExp(`\\.${name}\\s*\\{[^}]*padding-bottom:\\s*calc\\(272rpx \\+ env\\(safe-area-inset-bottom\\)\\)`).test(bankWxss))
  })
  assert('留白 - bank-detail 内部容器改用 100% 跟随父级',
    /\.workbench\s*\{[^}]*height:\s*100%/.test(bankWxss))

  // 首页靠 .sheet 的内边距让位
  const homeWxss = read('page/subject-list/index.wxss')
  const sheetBottom = Number((homeWxss.match(/\.sheet\s*\{[^}]*padding:\s*[^;}]*?(\d+)rpx\s*;/) || [])[1] || 0)

  assert(`留白 - 首页 .sheet 底部预留 ≥ ${reserved}rpx`, sheetBottom >= reserved, `实际 ${sheetBottom}rpx`)
}

// ---------- 二·补二、弹层覆盖底栏 ----------
function checkHiddenOnOverlay() {
  assert('弹层 - 底栏持续显示', !/setHidden|hidden:\s*false/.test(tabBarJs) && !/tabbar-hidden/.test(tabBarWxml))
  ;['subject-list', 'bank-detail', 'my', 'stats'].forEach(name => {
    assert(`弹层 - ${name} 使用统一层级`, !read(`page/${name}/index.js`).includes('setTabBarHidden'))
  })
  ;['bottom-sheet', 'question-overview-sheet', 'route-loading'].forEach(name => {
    const source = read(`components/${name}/index.wxml`)
    assert(`弹层 - ${name} 通过 root-portal 承载`, /<root-portal[^>]*wx:if="\{\{visible\}\}"/.test(source))
  })
  const sheet = read('components/bottom-sheet/index.wxml')
  assert('弹层 - 遮罩拦截点击与滚动', /class="mask"[^>]*catchtouchmove="noop"[^>]*catchtap="handleMaskTap"/.test(sheet))
  assert('弹层 - 页面隐藏时统一关闭弹窗', read('utils/page-lifecycle.js').includes('announcementSheetVisible'))
}

function checkLayout() {
  assert('布局 - 四个入口等宽', /\.tab-item\s*\{[^}]*flex:\s*1/.test(tabBarWxss))
  assert('布局 - 入口之间没有额外让位', !/\.tab-item:nth-child/.test(tabBarWxss))
  assert('布局 - 显示四个导航入口', /wx:for="\{\{tabs\}\}"/.test(tabBarWxml))
}

// ---------- 四、纯函数：去向解析 ----------

function loadTabBarModule() {
  const modulePath = path.join(MINIPROGRAM, 'custom-tab-bar/index.js')
  const source = fs.readFileSync(modulePath, 'utf8')
  const start = source.indexOf('const TAB_ROUTES = [')
  const end = source.indexOf('Component({')
  const head = source.slice(0, start)

  if (start < 0 || end < 0) {
    throw new Error('custom-tab-bar/index.js 结构变了，TAB_ROUTES 或 Component 定位失败')
  }

  // 只取 Component 之前的纯计算部分：这部分不依赖微信运行时
  const body = source.slice(start, end)
  const Module = require('module')
  const m = new Module(modulePath, null)
  m.filename = modulePath
  m.paths = Module._nodeModulePaths(path.dirname(modulePath))

  const wrapped = `${head}\n${body}\nmodule.exports = { TAB_ROUTES, findTabIndexByRoute }`

  return m._compile ? (() => {
    m._compile(wrapped, modulePath)
    return m.exports
  })() : null
}

function checkPureFunctions() {
  let exported = null

  try {
    exported = loadTabBarModule()
  } catch (error) {
    assert('纯函数 - 能独立加载 custom-tab-bar 的计算部分', false, error.message)
    return
  }

  if (!exported) {
    assert('纯函数 - 能独立加载 custom-tab-bar 的计算部分', false, '编译返回空')
    return
  }

  const { TAB_ROUTES, findTabIndexByRoute } = exported

  assert('纯函数 - TAB_ROUTES 有 4 项', TAB_ROUTES.length === 4, `实际 ${TAB_ROUTES.length}`)

  // 顺序必须严格等于 app.json 的 list，否则底栏高亮会错位
  const appOrder = appJson.tabBar.list.map((item) => `/${item.pagePath.replace(/^\//, '')}`)
  assert('纯函数 - TAB_ROUTES 顺序与 app.json 一致',
    TAB_ROUTES.map((item) => item.pagePath).join(',') === appOrder.join(','),
    `${TAB_ROUTES.map((i) => i.pagePath).join(',')} vs ${appOrder.join(',')}`)

  assert('纯函数 - 带前导斜杠可定位', findTabIndexByRoute('/page/stats/index') === 2)
  assert('纯函数 - 无前导斜杠可定位', findTabIndexByRoute('page/stats/index') === 2)
  assert('纯函数 - 带 query 可定位', findTabIndexByRoute('/page/my/index?from=login') === 3)
  assert('纯函数 - 未知路由返回 -1', findTabIndexByRoute('/page/practice/index') === -1)
  assert('纯函数 - 空路由返回 -1', findTabIndexByRoute('') === -1)
  assert('纯函数 - 非字符串返回 -1', findTabIndexByRoute(null) === -1)


}

// ---------- 输出 ----------

checkConfig()
checkSelectionSync()
checkBottomSpace()
checkHiddenOnOverlay()
checkLayout()
checkPureFunctions()

const failed = results.filter((item) => !item.passed)

results.forEach((item) => {
  if (!item.passed) {
    console.log(`FAIL  ${item.name}${item.detail ? ` —— ${item.detail}` : ''}`)
  }
})

console.log(`\n自定义 tabBar 自检：总计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)

if (failed.length) {
  process.exitCode = 1
}
