const assert = require('node:assert/strict')
const { parseContent, parseBlankContent, plainText, codeTokens, containsImage, validateTeachingSections, blankMarkers, contentMetadata, TEACHING_SECTIONS } = require('./content-format')
const code = 'console.log("<script>alert(1)</script>");\n'
assert.equal(plainText(codeTokens(code, 'javascript')), code)
assert.equal(parseContent('```javascript\n' + code + '```', 'MARKDOWN')[0].raw, code)
assert(!JSON.stringify(parseContent('<img src=x onerror=alert(1)> [x](javascript:alert(1))', 'MARKDOWN')).includes('"href"'))
assert.equal(plainText(parseContent('**literal**', 'PLAIN_TEXT')), '**literal**')
assert(containsImage('![figure](https://example.com/a.png)'))
assert(!containsImage('```text\n![figure](image.png)\n```'))
assert(validateTeachingSections(TEACHING_SECTIONS.map(title => `### ${title}\n内容`).join('\n\n'), 'MARKDOWN'))
assert(!validateTeachingSections('```text\n' + TEACHING_SECTIONS.map(title => `### ${title}\n内容`).join('\n') + '\n```', 'MARKDOWN'))
assert.deepEqual(blankMarkers('答案 {{1}}，字面量 \\{{2}}'), ['1'])
const collectSlots = nodes => nodes.flatMap(node => node.blankIndex === undefined ? collectSlots(node.children || []) : [node.blankIndex])
const paper = parseBlankContent('程序输出 **{{1}}**。字面量 \\{{2}}\n\n```js\nconsole.log(1 + 2)\n```', 'MARKDOWN')
assert.deepEqual(collectSlots(paper), [0])
assert.equal(paper[1].raw, 'console.log(1 + 2)\n')
assert(plainText(paper).includes('{{2}}'))
assert.deepEqual(collectSlots(parseBlankContent('QandaBlankSlot {{1}} / {{2}}', 'PLAIN_TEXT')), [0, 1])
const legacy = parseBlankContent('```text\n{{1}}\n```', 'MARKDOWN')
assert.deepEqual(collectSlots(legacy[0].children), [])
assert.equal(legacy[0].raw, '{{1}}\n')
assert.deepEqual(collectSlots(legacy[1].children), [0])
assert.throws(() => contentMetadata({ type: 'SINGLE_CHOICE', presentation: 'CODE_WRITING' }))
assert.throws(() => contentMetadata({ type: 'SHORT_ANSWER', presentation: 'CODE_WRITING' }))
assert.equal(contentMetadata({ type: 'SHORT_ANSWER', presentation: 'CODE_ANALYSIS' }).presentation, 'CODE_ANALYSIS')
assert.throws(() => contentMetadata({ type: 'FILL_BLANK', presentation: 'CODE_ANALYSIS', codeLanguage: 'javascript' }))
const vm = require('node:vm')
const fs = require('node:fs')
const sandbox = { module: { exports: {} } }
vm.runInNewContext('(function(module) {\n' + fs.readFileSync(require.resolve('./dist/content-format.js'), 'utf8') + '\n})(module)', sandbox)
for (const language of sandbox.module.exports.LANGUAGES) {
  const tokens = sandbox.module.exports.codeTokens('int count = 1; // example', language)
  assert.equal(sandbox.module.exports.plainText(tokens), 'int count = 1; // example')
}
assert(sandbox.module.exports.codeTokens('int count = 1;', 'c').some(token => token.token === 'keyword'))
assert.equal(sandbox.Prism, undefined)

const formulas = nodes => nodes.flatMap(value => value.tex ? [value.tex] : formulas(value.children || []))
for (const format of ['MARKDOWN', 'PLAIN_TEXT']) {
  const text = 'H_2O、x^2、$\\frac{a_i}{\\sqrt{2}}$、$$\\sum_{i=1}^n a_i$$，user_id、`x^2`、https://example.org/a_1'
  const nodes = parseContent(text, format, true)
  assert.deepEqual(formulas(nodes), ['H_2O', 'x^2', '\\frac{a_i}{\\sqrt{2}}', '\\sum_{i=1}^n a_i'])
  assert.deepEqual(formulas(parseContent(text, format)), [])
  const mixed = parseBlankContent('$x^2$ 对应 {{1}}', format, true)
  assert.deepEqual(collectSlots(mixed), [0])
  assert.deepEqual(formulas(mixed), ['x^2'])
}
assert.deepEqual(formulas(parseContent('\\$5、`$x$`、[原文](https://example.org/a_2)\n\n```js\nx^2\n```', 'MARKDOWN', true)), [])
const { renderFormula } = require('./math-svg.js')
for (const tex of ['H_2O', '\\frac{a_i}{\\sqrt{2}}', '\\sum_{i=1}^n a_i']) {
  const svg = renderFormula(tex, true)
  assert.match(svg.xml, /<path\b/)
  assert.ok(parseFloat(svg.width) > 0 && parseFloat(svg.height) > 0)
}
assert.throws(() => renderFormula('\\invalidTeXcommand', false))

assert.deepEqual(collectSlots(parseBlankContent('$x + {{1}}$', 'MARKDOWN', true)), [0])
assert.deepEqual(formulas(parseContent('费用 $5、$10', 'PLAIN_TEXT', true)), [])
console.log('content-format checks passed')
