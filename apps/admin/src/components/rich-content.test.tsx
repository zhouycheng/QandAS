import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RichContent } from './rich-content'
import { QuestionContentView } from '../pages/questions/question-content-view'
import { parseImportFile } from '../lib/question-bank-file'
import codeExample from '../../../../docs/question-bank-import/examples/code-content.json'

describe('safe content and review preview', () => {
  it('places answer lines in prose and keeps demonstration code intact', () => {
    const html = renderToStaticMarkup(<RichContent format="MARKDOWN" text={'程序输出 {{1}}。\n\n```js\nconsole.log(1 + 2)\n```'} blanks={['3']} />)
    expect(html).toContain('value="3"')
    expect(html).not.toContain('{{1}}')
    expect(html.match(/<input/g)).toHaveLength(1)
    expect(html.slice(html.indexOf('<pre'), html.indexOf('</pre>'))).not.toContain('<input')
  })
  it('renders code as nodes, escapes HTML and exposes only HTTPS links', () => {
    const html = renderToStaticMarkup(<RichContent format="MARKDOWN" text={'<script>alert(1)</script>\n\n```html\n<img onerror="alert(1)">\n```\n\n[x](javascript:alert(1)) [站点](https://example.test)'} />)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img ')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('rich-code-bar')
    expect(html).toContain('token-')
  })
  it('keeps subjective references until review, with code metadata through import', () => {
    const parsed = parseImportFile(JSON.stringify(codeExample), 'bank')
    const subjective = parsed.questions.find(question => question.presentation === 'CODE_ANALYSIS' && question.type === 'SHORT_ANSWER')!
    expect(subjective.contentFormat).toBe('MARKDOWN')
    const question = { ...subjective, referenceAnswer: 'reference-secret', scoringPoints: ['point-secret'], explanation: 'explanation-secret' }
    for (const stage of ['answer', 'feedback'] as const) {
      const html = renderToStaticMarkup(<QuestionContentView question={question} stage={stage} />)
      expect(html).not.toContain('reference-secret')
      expect(html).not.toContain('point-secret')
      expect(html).not.toContain('explanation-secret')
      expect(html).toContain('不计分')
    }
    expect(renderToStaticMarkup(<QuestionContentView question={question} stage="review" />)).toContain('reference-secret')
  })
})
