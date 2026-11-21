const { mathjax } = require('mathjax-full/js/mathjax.js')
const { TeX } = require('mathjax-full/js/input/tex.js')
const { SVG } = require('mathjax-full/js/output/svg.js')
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js')
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js')
require('mathjax-full/js/input/tex/ams/AmsConfiguration.js')

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)
const document = mathjax.document('', {
  InputJax: new TeX({ packages: ['base', 'ams'], formatError(_, error) { throw error } }),
  OutputJax: new SVG({ fontCache: 'none' })
})
const cache = new Map()
function renderFormula(tex, display) {
  const key = JSON.stringify([tex, display])
  if (cache.has(key)) return cache.get(key)
  const svg = adaptor.firstChild(document.convert(tex, { display }))
  const width = adaptor.getAttribute(svg, 'width')
  const height = adaptor.getAttribute(svg, 'height')
  const align = adaptor.getStyle(svg, 'vertical-align') || '0'
  const xml = adaptor.outerHTML(svg).replace(/currentColor/g, '#252932')
  const result = { xml, width, height, align }
  if (cache.size >= 32) cache.delete(cache.keys().next().value)
  cache.set(key, result)
  return result
}
module.exports = { renderFormula }
