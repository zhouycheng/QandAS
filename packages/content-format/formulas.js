// Match only unambiguous bare scripts; identifiers with multiple letters stay literal.
const legacy = /(?:^|[^\w\\])([A-Za-z](?:[_^](?:\{[-+\w]+\}|[-+]?\d+|[a-z](?!\w)))+(?:[A-Z][a-z]?)?)(?!\w)/g
const formula = (raw, tex, display = false) => ({ tag: 'span', children: [{ text: raw }], tex, display })

function splitLegacy(text) {
  const parts = []
  let cursor = 0
  legacy.lastIndex = 0
  let match
  while ((match = legacy.exec(text))) {
    const end = legacy.lastIndex
    const start = end - match[1].length
    if (start > cursor) parts.push({ text: text.slice(cursor, start) })
    parts.push(formula(match[1], match[1]))
    cursor = end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  return parts
}

function delimited(text, pos) {
  if (text[pos] !== '$') return null
  const display = text[pos + 1] === '$'
  const delimiter = display ? '$$' : '$'
  const start = pos + delimiter.length
  if (!display && /\s/.test(text[start] || ' ')) return null
  for (let end = start; end < text.length; end++) {
    if (text[end] === '\\') { end++; continue }
    if (!display && text[end] === '\n') return null
    if (!text.startsWith(delimiter, end)) continue
    const tex = text.slice(start, end)
    if (!tex.trim() || (!display && (/\s$/.test(tex) || /\d/.test(text[end + 1] || '')))) return null
    return formula(text.slice(pos, end + delimiter.length), tex.trim(), display)
  }
  return null
}

function splitPlain(text) {
  const parts = []
  const tokens = /https?:\/\/[^\s]+|`+[^`\n]*`+|\\\$|\$/g
  let match, cursor = 0
  while ((match = tokens.exec(text))) {
    const value = match[0] === '$' ? delimited(text, match.index) : null
    if (!value && match[0] === '$') continue
    parts.push(...splitLegacy(text.slice(cursor, match.index)), value || { text: match[0] })
    cursor = match.index + (value ? value.children[0].text.length : match[0].length)
    tokens.lastIndex = cursor
  }
  return parts.concat(splitLegacy(text.slice(cursor)))
}

function splitPlainLegacy(text) {
  return text.split(/(https?:\/\/[^\s]+)/g).flatMap((part, i) => i % 2 ? [{ text: part }] : splitLegacy(part))
}
module.exports = { delimited, splitPlainLegacy, splitPlain }
