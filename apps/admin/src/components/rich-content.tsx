import { createElement, type ReactNode } from 'react'
import { Message } from '@arco-design/web-react'
import { parseContent, parseBlankContent, codeTokens, containsImage, type ContentNode } from '@qanda/content-format'
import './rich-content.css'

export function RichContent({ text = '', format = 'PLAIN_TEXT', codeLanguage, blanks }: { text?: string; format?: string; codeLanguage?: string; blanks?: string[] }) {
  const nodes = codeLanguage ? [{ tag: 'pre', children: codeTokens(text, codeLanguage), raw: text, language: codeLanguage }] : blanks ? parseBlankContent(text, format) : parseContent(text, format)
  const render = (items: ContentNode[]): ReactNode => items.map((item, index) => {
    if (item.text !== undefined) return item.text
    if (item.blankIndex !== undefined) return <input className="rich-blank" key={index} aria-label="填写空白处" value={blanks?.[item.blankIndex] || ''} readOnly />
    const children = render(item.children || [])
    if (item.tag === 'pre') return <div className="rich-code" key={index}><div className="rich-code-bar"><span>{item.language || 'text'}</span><button type="button" onClick={() => navigator.clipboard.writeText(item.raw || '').then(() => Message.success('代码已复制'), () => Message.error('复制失败，请选择代码后复制'))}>复制</button></div><pre tabIndex={0}><code>{children}</code></pre></div>
    if (item.tag === 'table') return <div className="rich-table" key={index} tabIndex={0}><table>{children}</table></div>
    const props = { key: index, ...(item.token ? { className: `token-${item.token}` } : {}), ...(item.tag === 'a' ? { href: item.href, target: '_blank', rel: 'noopener noreferrer' } : {}), ...(item.tag === 'ol' ? { start: item.start } : {}) }
    return createElement(item.tag || 'span', props, item.tag === 'br' || item.tag === 'hr' ? undefined : children)
  })
  return <div className="rich-content">{format === 'MARKDOWN' && containsImage(text) && <p role="status">正文中的图片仅显示说明文字，请使用图片附件。</p>}{render(nodes)}</div>
}
