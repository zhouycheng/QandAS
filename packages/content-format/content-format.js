const MarkdownIt = require('markdown-it')
const Prism = require('prismjs')
require('prismjs/components/prism-c')
require('prismjs/components/prism-cpp')
require('prismjs/components/prism-java')
require('prismjs/components/prism-python')
require('prismjs/components/prism-typescript')
require('prismjs/components/prism-sql')
require('prismjs/components/prism-json')
require('prismjs/components/prism-bash')

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false, maxNesting: 20 })
markdown.validateLink = value => /^https:\/\/[^\s]+$/i.test(value)
const TEACHING_SECTIONS = ['结论', '核心知识点', '解题过程', '记忆方法', '易错题型']
const LANGUAGES = ['c', 'cpp', 'java', 'python', 'javascript', 'typescript', 'sql', 'json', 'html', 'css', 'bash', 'text']
const aliases = { js: 'javascript', ts: 'typescript', py: 'python', 'c++': 'cpp', shell: 'bash', sh: 'bash', html: 'markup', text: 'plain', plaintext: 'plain' }
const cache = new Map()
const node = (tag, children, extra) => Object.assign({ tag, children }, extra || {})
const literal = text => ({ text })

function codeTokens(value, language) {
  const grammar = Prism.languages[aliases[language] || language]
  if (!grammar) return [literal(value)]
  const convert = tokens => tokens.map(token => typeof token === 'string' ? literal(token) : node('span', convert(Array.isArray(token.content) ? token.content : [token.content]), { token: token.type }))
  return convert(Prism.tokenize(value, grammar))
}

function parseContent(source, format = 'PLAIN_TEXT') {
  const text = String(source == null ? '' : source)
  if (format !== 'MARKDOWN') return [node('p', [literal(text)])]
  const key = format + ':' + text
  if (cache.has(key)) return cache.get(key)
  const root = [], stack = [root]
  function append(tokens) {
    for (const token of tokens) {
      const children = stack[stack.length - 1]
      if (token.type === 'inline') { append(token.children || []); continue }
      if (token.type === 'image') { children.push(literal(token.content)); continue }
      if (token.type === 'fence' || token.type === 'code_block') {
        const language = (token.info || '').trim().split(/\s+/)[0].toLowerCase()
        children.push(node('pre', codeTokens(token.content, language), { language: LANGUAGES.includes(language) || aliases[language] ? language : 'text', raw: token.content }))
      } else if (token.type === 'code_inline') children.push(node('code', [literal(token.content)]))
      else if (token.type === 'softbreak' || token.type === 'hardbreak') children.push(node('br', []))
      else if (token.type === 'hr') children.push(node('hr', []))
      else if (token.nesting === 1) {
        const allowed = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a']
        const tag = allowed.includes(token.tag) ? token.tag : 'span'
        const value = node(tag, [])
        if (tag === 'a') value.href = token.attrGet('href') || ''
        if (tag === 'ol') value.start = Number(token.attrGet('start')) || 1
        children.push(value); stack.push(value.children)
      } else if (token.nesting === -1) stack.pop()
      else if (token.content) children.push(literal(token.content))
    }
  }
  append(markdown.parse(text, {}))
  // Bound cached ASTs; large banks are rendered one visible question at a time.
  if (cache.size >= 64) cache.delete(cache.keys().next().value)
  cache.set(key, root)
  return root
}

function plainText(nodes) { return nodes.map(value => value.text === undefined ? plainText(value.children || []) : value.text).join('') }
function parseBlankContent(source, format) {
  let prefix = 'QandaBlankSlot'
  while (source.includes(prefix)) prefix += 'X'
  const pattern = new RegExp(prefix + '(\\d+)EndMarker', 'g')
  const marked = source.replace(/\{\{(\d+)\}\}/g, (match, number, offset) => source[offset - 1] === '\\' ? match : `${prefix}${number}EndMarker`)
  const split = text => {
    const parts = []; let cursor = 0
    text.replace(pattern, (match, number, offset) => { if (offset > cursor) parts.push(literal(text.slice(cursor, offset))); parts.push(node('span', [], { blankIndex: Number(number) - 1 })); cursor = offset + match.length; return match })
    if (cursor < text.length) parts.push(literal(text.slice(cursor)))
    return parts
  }
  const convert = nodes => nodes.flatMap(value => {
    if (value.tag === 'pre') {
      const slots = split(value.raw).filter(part => part.blankIndex !== undefined)
      const raw = value.raw.replace(pattern, (_, number) => `{{${number}}}`)
      const code = { ...value, raw, children: codeTokens(raw, value.language) }
      // Older packages may place markers in examples; their inputs sit after the code.
      return slots.length ? [code, node('p', [literal('作答：'), ...slots])] : [code]
    }
    return value.text === undefined ? [{ ...value, children: convert(value.children || []) }] : split(value.text)
  })
  return convert(parseContent(marked, format))
}
function containsImage(source) {
  const visit = tokens => tokens.some(token => token.type === 'image' || token.children && visit(token.children))
  return visit(markdown.parse(String(source || ''), {}))
}
function validateTeachingSections(source, format) {
  if (format !== 'MARKDOWN') {
    const headings = String(source).split('\n').map(line => line.trim().replace(/[：:]$/, '')).filter(line => TEACHING_SECTIONS.includes(line))
    return headings.join('|') === TEACHING_SECTIONS.join('|')
  }
  const tokens = markdown.parse(source, {})
  const sections = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue
    const title = tokens[i + 1].content.trim()
    if (!TEACHING_SECTIONS.includes(title)) continue
    let end = i + 3
    while (end < tokens.length && tokens[end].type !== 'heading_open') end++
    if (!tokens.slice(i + 3, end).some(token => token.content.trim())) return false
    sections.push(title)
  }
  return sections.join('|') === TEACHING_SECTIONS.join('|')
}
function blankMarkers(source) {
  const text = String(source)
  const markers = [], pattern = /\{\{([^{}]*)\}\}/g
  let match
  while ((match = pattern.exec(text))) if (text[match.index - 1] !== '\\') markers.push(match[1])
  return markers
}
function contentMetadata(input) {
  const contentFormat = input.contentFormat === undefined ? 'PLAIN_TEXT' : input.contentFormat
  const presentation = input.presentation === undefined ? 'STANDARD' : input.presentation
  if (!['PLAIN_TEXT', 'MARKDOWN'].includes(contentFormat)) throw new Error('正文格式无效')
  if (!['STANDARD', 'CONCEPT', 'CODE_ANALYSIS'].includes(presentation)) throw new Error('展示方式无效，请使用普通题目、概述或代码分析')
  if (['CONCEPT', 'CODE_ANALYSIS'].includes(presentation) && !['FILL_BLANK', 'SHORT_ANSWER'].includes(input.type)) throw new Error('展示方式与作答题型不匹配')
  if (input.codeLanguage != null) throw new Error('请在 Markdown 代码围栏中指定语言')
  return { contentFormat, presentation, codeLanguage: null }
}

module.exports = { parseContent, parseBlankContent, plainText, codeTokens, containsImage, validateTeachingSections, blankMarkers, contentMetadata, TEACHING_SECTIONS, LANGUAGES }
