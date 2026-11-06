const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const tokens = require('../miniprogram/utils/design-tokens.js')
const { generateTheme } = require('../scripts/generate-design-tokens.cjs')
const { readStyles } = require('../scripts/preview-styles.cjs')
const root = path.resolve(__dirname, '../miniprogram')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
assert.equal(read('styles/theme.wxss'), generateTheme())
assert.equal(read('styles/page-theme.wxss'), generateTheme('page'))
assert.deepEqual(Object.values(tokens.readingSizes), [14, 18, 20, 22, 24])
assert.deepEqual(Object.values(tokens.fontSizes), [11, 12, 14, 16, 18, 24])
for (const [file, selector] of [['page/subject-list/index.wxss', 'hero-brand'], ['page/bank-detail/index.wxss', 'bk-title'], ['page/stats/index.wxss', 'page-head-title'], ['page/my/index.wxss', 'page-head-title']]) {
  const rule = readStyles(path.join(root, file)).match(new RegExp('\\.' + selector + '\\s*\\{([^}]+)'))[1]
  assert.ok(rule.includes('font-size: var(--font-title)'), file + ' navigation size')
  assert.ok(rule.includes('line-height: var(--leading-title)'), file + ' navigation line height')
  assert.ok(rule.includes('font-weight: 600'), file + ' navigation weight')
}
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255)
  return rgb.map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((v, x, i) => v + x * [.2126, .7152, .0722][i], 0)
}
for (const [foreground, background] of [['brand', 'card'], ['text-main', 'card'], ['text-sub', 'page-bg'], ['success', 'success-soft'], ['warning', 'warning-soft'], ['danger', 'danger-soft']]) {
  const [low, high] = [luminance(tokens.colors[foreground]), luminance(tokens.colors[background])].sort((a, b) => a - b)
  assert.ok((high + .05) / (low + .05) >= 4.5, foreground + ' contrast')
}
for (const component of fs.readdirSync(path.join(root, 'components'))) {
  const css = path.join(root, 'components', component, 'index.wxss')
  if (fs.existsSync(css)) assert.ok(readStyles(css).includes('--font-body: 14px;'), component + ' isolated theme')
}
const home = read('page/subject-list/index.wxss')
for (const name of ['recent', 'mock', 'wrong', 'favorite']) {
  const match = home.match(new RegExp(`\\.entry-icon-${name}\\s*\\{[^}]*base64,([^"\\s]+)`))
  const svg = Buffer.from(match[1], 'base64').toString()
  assert.ok(svg.includes(tokens.colors.brand))
  assert.ok(!svg.includes('Gradient'), name + ' solid icon')
}
const settings = read('page/settings/index.wxml')
assert.ok(settings.indexOf('settings-actions') > settings.indexOf('font-preview'))
assert.equal(JSON.parse(read('app.json')).tabBar.selectedColor, tokens.colors.brand)
console.log('视觉规范通过：主题生成、隔离组件、阅读档位、对比度、纯色入口和底部恢复默认')
