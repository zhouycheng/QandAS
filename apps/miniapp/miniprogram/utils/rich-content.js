const { colors: theme } = require('./design-tokens.js')
const { parseContent, parseBlankContent, codeTokens } = require('@qanda/content-format')
const colors = { keyword: '#7c3aed', boolean: '#7c3aed', string: '#067647', char: '#067647', number: '#b45309', function: '#b45309', comment: '#667085', tag: '#0e7490', 'attr-name': '#7c3aed', 'attr-value': '#067647', property: '#0e7490', selector: '#b45309', operator: '#667085', punctuation: '#667085', 'class-name': '#b45309' }
const styles = { p: 'white-space:pre-wrap;margin:8px 0;', code: 'font-family:monospace;', pre: 'white-space:pre;overflow-wrap:normal;word-break:normal;font-family:monospace;', blockquote: `border-left:3px solid ${theme.line};padding-left:12px;margin:8px 0;`, table: 'border-collapse:collapse;min-width:100%;', th: `border:1px solid ${theme.line};padding:6px;`, td: `border:1px solid ${theme.line};padding:6px;` }

function richNodes(nodes) {
  return nodes.map(value => value.text !== undefined ? { type: 'text', text: value.text } : {
    name: value.tag === 'a' ? 'span' : value.tag,
    attrs: { ...(value.tag === 'ol' ? { start: value.start || 1 } : {}), style: (styles[value.tag] || (/^h[1-6]$/.test(value.tag) ? 'font-size:1em;font-weight:600;margin:12px 0 6px;' : '')) + (colors[value.token] ? `color:${colors[value.token]};` : '') + (value.continuation ? 'list-style-type:none;' : '') },
    children: richNodes(value.children || [])
  })
}

function contentBlocks(text, format, language, blanks, images) {
  const nodes = language ? [{ tag: 'pre', children: codeTokens(text, language), language, raw: text }] : blanks ? parseBlankContent(text, format, true) : parseContent(text, format, true)
  const blocks = [], links = []
  const isScroll = value => value.tag === 'pre' || value.tag === 'table'
  const hasScroll = value => isScroll(value) || (value.children || []).some(hasScroll)
  const hasEmbed = value => value.tex || value.blankIndex !== undefined || (images && value.assetId) || (value.children || []).some(hasEmbed)
  function inlineParts(value) {
    const parts = []
    const inline = (entry, wrappers) => {
      if (entry.tex) { parts.push({ tex: entry.tex, raw: entry.children[0].text, display: entry.display }); return }
      if (images && entry.assetId) { parts.push({ assetId: entry.assetId, alt: (entry.children[0] || {}).text || '题目插图' }); return }
      if (entry.blankIndex !== undefined) { parts.push({ blankIndex: entry.blankIndex, value: blanks[entry.blankIndex] && blanks[entry.blankIndex].value || '' }); return }
      if (entry.tag === 'br') { parts.push({ break: true }); return }
      if (entry.text !== undefined) {
        let leaf = entry
        for (let i = wrappers.length - 1; i >= 0; i--) leaf = { ...wrappers[i], children: [leaf] }
        parts.push({ nodes: richNodes([leaf]) }); return
      }
      ;(entry.children || []).forEach(child => inline(child, ['strong', 'em', 's', 'code', 'span', 'a'].includes(entry.tag) ? wrappers.concat(entry) : wrappers))
    }
    inline(value, [])
    return parts.map((part, index) => Object.assign({ index }, part))
  }
  function visit(value, ancestors) {
    if (value.href && !links.includes(value.href)) links.push(value.href)
    const container = ['ol', 'ul', 'li', 'blockquote'].includes(value.tag)
    if (!isScroll(value) && (hasScroll(value) || container && hasEmbed(value))) {
      const context = { value, continued: false }
      ;(value.children || []).forEach((child, index) => {
        if (value.tag === 'ol') context.value = { ...value, start: (value.start || 1) + index }
        visit(child, ancestors.concat(context))
      })
      return
    }
    const collectLinks = children => children.forEach(child => { if (child.href && !links.includes(child.href)) links.push(child.href); collectLinks(child.children || []) })
    collectLinks(value.children || [])
    let wrapped = value
    let marker = ''
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const context = ancestors[i]
      if (context.value.tag === 'li' && !context.continued && !marker) {
        const list = ancestors[i - 1] && ancestors[i - 1].value
        marker = list && list.tag === 'ol' ? (list.start || 1) + '.' : '•'
      }
      wrapped = { ...context.value, children: [wrapped], continuation: context.value.tag === 'li' && context.continued }
      context.continued = true
    }
    const embedded = hasEmbed(value)
    const parts = embedded && value.tag !== 'table' ? inlineParts(value) : null
    const rows = value.tag === 'table' && embedded ? value.children.flatMap(section => section.children).map((row, index) => ({ index, cells: row.children.map((cell, index) => ({ index, header: cell.tag === 'th', parts: inlineParts(cell) })) })) : null
    blocks.push({ index: blocks.length, tag: value.tag, language: value.language || 'text', raw: value.raw || '', nodes: richNodes([wrapped]), parts, rows, marker, heading: /^h[1-6]$/.test(value.tag), quoted: ancestors.some(context => context.value.tag === 'blockquote') })
  }
  nodes.forEach(value => visit(value, []))
  // The parent owns outer spacing; Markdown keeps spacing between its paragraphs.
  const first = blocks[0] && blocks[0].nodes[0]
  const last = blocks.length && blocks[blocks.length - 1].nodes[0]
  if (first && first.attrs) first.attrs.style += 'margin-top:0;'
  if (last && last.attrs) last.attrs.style += 'margin-bottom:0;'
  return { blocks, links }
}

module.exports = { contentBlocks }
