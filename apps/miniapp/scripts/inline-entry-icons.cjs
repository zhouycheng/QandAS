// Home entries use megaphone-derived gradients and white artwork.
const fs = require('node:fs')
const path = require('node:path')
const { colors, homeEntryColors } = require('../miniprogram/utils/design-tokens.js')
const target = path.join(__dirname, '../miniprogram/page/subject-list/index.wxss')
const icons = {
  recent: `<rect x="27" y="31" width="42" height="39" rx="8" fill="white"/><path d="M37 25v12m22-12v12" stroke="white" stroke-width="5" stroke-linecap="round"/><path d="m41 59 18-18 6 6-18 18-9 3z" fill="white" stroke="${colors.brand}" stroke-width="3" stroke-linejoin="round"/>`,
  mock: `<rect x="29" y="30" width="40" height="43" rx="9" fill="white"/><rect x="40" y="24" width="18" height="11" rx="5" fill="white"/><path d="m40 51 7 7 12-13" fill="none" stroke="${colors.brand}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
  wrong: `<rect x="28" y="29" width="40" height="44" rx="9" fill="white"/><path d="M25 39h9m-9 12h9m-9 12h9" stroke="white" stroke-width="5" stroke-linecap="round"/><path d="m42 45 13 13m0-13L42 58" stroke="${colors.brand}" stroke-width="5" stroke-linecap="round"/>`,
  favorite: `<path d="M27 33h14l6 7h22a7 7 0 0 1 7 7v19a7 7 0 0 1-7 7H27a7 7 0 0 1-7-7V40a7 7 0 0 1 7-7" fill="white"/><path d="m48 46 3 7 7 1-6 4 2 7-6-4-6 4 2-7-6-4 7-1z" fill="${colors.brand}"/>`
}
let source = fs.readFileSync(target, 'utf8')
for (const [name, body] of Object.entries(icons)) {
  const [highlight, base] = homeEntryColors[name]
  const artwork = body.replaceAll(colors.brand, base)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${highlight}"/><stop offset="1" stop-color="${base}"/></linearGradient></defs><rect width="96" height="96" rx="26" fill="url(#tile)"/>${artwork}</svg>`
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  const pattern = new RegExp(`(\\.entry-icon-${name}\\s*\\{[^}]*?background-image:\\s*url\\(")[^"]*(")`)
  if (!pattern.test(source)) throw new Error('缺少首页入口图标：' + name)
  source = source.replace(pattern, `$1${uri}$2`)
}
fs.writeFileSync(target, source)
