import { RichContent } from '../../components/rich-content'
import { QuestionImages } from '../../components/question-images'
import { useRef, useState } from 'react'
import { Alert, Button, Checkbox, Divider, Form, Input, Modal, Radio, Select, Space, Tag } from '@arco-design/web-react'
import { IconArrowDown, IconArrowUp, IconDelete, IconPlus } from '@arco-design/web-react/icon'
import { questionTypeLabels } from '../../lib/labels'
import { createQuestionContent } from '../../lib/question-content'
import type { AtomicQuestionContent, AtomicQuestionType, QuestionContent, QuestionType, ReadingSubQuestion } from '../../types/admin'

export function QuestionContentEditor({ value, onChange, disabled, prefix = '', allowReading = true, bankId, onBusyChange }: {
  value: QuestionContent
  onChange: (value: QuestionContent) => void
  disabled: boolean
  prefix?: string
  allowReading?: boolean
  bankId?: string
  onBusyChange?: (delta: number) => void
}) {
  const [newSubType, setNewSubType] = useState<AtomicQuestionType>('SINGLE_CHOICE')
  const q = value
  const change = (patch: Partial<QuestionContent>) => onChange({ ...q, ...patch })
  const label = (name: string) => `${prefix}${name}`
  const picker = useRef<HTMLInputElement>(null)
  const selection = useRef<{ field: 'passage'; start: number; end: number } | null>(null)
  const references: Record<string,string[]> = {}
  const fields = [['题干', q.stem], ['阅读材料', q.passage], ['解析',q.explanation], ['参考答案',q.referenceAnswer], ...(q.scoringPoints || []).map(text => ['参考要点', text]), ...q.options.map(o => ['选项 ' + o.key, o.content])]
  for (const [field, text] of fields) for (const match of (text || '').matchAll(/!\[([^\]\n]*)\]\(asset:([\w.-]+)\)/g)) {
    ;(references[match[2]] ??= []).push(field!)
  }
  function fieldPreview(text?: string) {
    if (q.contentFormat !== 'MARKDOWN' || !text || !/(?:^|\n) {0,3}(?:`{3,}|~{3,})|!\[[^\]]*\]\(asset:/.test(text)) return null
    return <div className="question-field-preview"><RichContent text={text} format={q.contentFormat} assetIds={q.assetIds} /></div>
  }
  function insertButton(field: 'passage') {
    return <Button size="mini" disabled={disabled || q.contentFormat !== 'MARKDOWN'} onClick={event => {
      const area = (event.currentTarget as HTMLElement).closest('.arco-form-item')?.querySelector('textarea')
      selection.current = { field, start: area?.selectionStart ?? q[field]?.length ?? 0, end: area?.selectionEnd ?? q[field]?.length ?? 0 }
      picker.current?.click()
    }}>插图</Button>
  }
  const choice = ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE'].includes(q.type)
  const subQuestions = q.subQuestions ?? []
  const changeType = (type: QuestionType) => {
    if (type === q.type) return
    const next = createQuestionContent(type)
    next.stem = type === 'FILL_BLANK' ? `${q.stem} {{1}}`.trim() : q.stem
    next.explanation = q.explanation
    next.contentFormat = q.contentFormat
    next.assetIds = q.assetIds
    const cleared: string[] = []
    const bothChoice = ['SINGLE_CHOICE', 'MULTIPLE_CHOICE'].includes(q.type) && ['SINGLE_CHOICE', 'MULTIPLE_CHOICE'].includes(type)
    if (bothChoice) {
      next.options = q.options
      if (type === 'SINGLE_CHOICE' && q.correctAnswer.length > 1) cleared.push('多个正确答案，请重新选择一个')
      else next.correctAnswer = q.correctAnswer
    } else {
      if (q.options.some(option => option.content.trim())) cleared.push('原选项')
      if (q.correctAnswer.length) cleared.push('正确答案')
    }
    if (q.blanks?.some(blank => blank.answers.some(Boolean))) cleared.push('填空答案')
    if (q.referenceAnswer?.trim()) cleared.push('参考答案')
    if (q.scoringPoints?.some(Boolean)) cleared.push('评分要点')
    if (q.passage?.trim()) cleared.push('阅读材料')
    if (subQuestions.length) cleared.push(`${subQuestions.length} 道阅读小题`)
    if (cleared.length) Modal.confirm({ title: '切换题型？', content: '将清除：' + cleared.join('、'), okText: '切换题型', cancelText: '保留原题型', onOk: () => onChange(next) })
    else onChange(next)
  }
  const updateSub = (id: string, next: QuestionContent) => change({ subQuestions: subQuestions.map((sub) => sub.id === id ? { ...next as AtomicQuestionContent, id } : sub) })
  const moveSub = (index: number, direction: number) => {
    const next = [...subQuestions]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    change({ subQuestions: next })
  }
  const removeSub = (sub: ReadingSubQuestion) => {
    const remove = () => change({ subQuestions: subQuestions.filter((s) => s.id !== sub.id) })
    if (sub.stem.trim()) Modal.confirm({ title: '移除这道小题？', content: '保存题组后生效。取消整个编辑可以保留原有内容。', okText: '移除小题', cancelText: '继续编辑', onOk: remove })
    else remove()
  }
  return <div className="bw-content-editor">
    <Form.Item label={label('题型')} required>
      <Select aria-label={label('题型')} value={q.type} disabled={disabled} onChange={changeType}
        options={Object.entries(questionTypeLabels).filter(([type]) => allowReading || type !== 'READING').map(([value, label]) => ({ value, label }))} />
    </Form.Item>
    {['FILL_BLANK', 'SHORT_ANSWER'].includes(q.type) && <Form.Item label={label('展示方式')} extra={q.presentation === 'CODE_ANALYSIS' ? '在题干中给出完整代码；填空题填写运行结果，简答题说明自己的理解。' : undefined}><Select value={q.presentation || 'STANDARD'} disabled={disabled} options={[{ value: 'STANDARD', label: '普通题目' }, { value: 'CONCEPT', label: '概述题' }, { value: 'CODE_ANALYSIS', label: '代码分析' }]} onChange={presentation => change({ presentation, codeLanguage: null, ...(presentation === 'CODE_ANALYSIS' && q.type === 'FILL_BLANK' ? { blankMatch: { ignoreCase: false, trimWhitespace: q.blankMatch?.trimWhitespace ?? true } } : {}) })} /></Form.Item>}
    <Form.Item label={label(q.type === 'READING' ? '题组标题' : '题干')} required={q.type !== 'READING'}
      extra={q.type === 'FILL_BLANK' ? '用 {{1}}、{{2}} 标记空位，每个编号在题干中出现一次。添加空位会自动补到题干末尾，可调整位置。' : undefined}>
      <Input.TextArea aria-label={label(q.type === 'READING' ? '题组标题' : '题干')} value={q.stem} disabled={disabled} onChange={(stem) => change({ stem })}
        placeholder={q.type === 'READING' ? '例如：Unit 1 · Campus Life' : q.type === 'FILL_BLANK' ? '例如：水的化学式是 {{1}}，常压沸点是 {{2}} ℃。' : '输入题目内容'} maxLength={10000} showWordLimit autoSize={{ minRows: 3, maxRows: 20 }} />
      {q.type !== 'READING' && fieldPreview(q.stem)}
    </Form.Item>
    {choice && <>
      <Divider orientation="left">选项与答案 · 勾选正确项</Divider>
      <div className="option-editor">
        {q.options.map((option, index) => <div key={option.key}><div className="option-row">
          {q.type === 'MULTIPLE_CHOICE'
            ? <Checkbox aria-label={label('正确答案 ' + option.key)} disabled={disabled || !option.content.trim()} checked={q.correctAnswer.includes(option.key)}
                onChange={checked => change({ correctAnswer: checked ? [...q.correctAnswer, option.key] : q.correctAnswer.filter(key => key !== option.key) })}>{option.key}</Checkbox>
            : <Radio aria-label={label('正确答案 ' + option.key)} checked={q.correctAnswer.includes(option.key)} disabled={disabled || !option.content.trim()}
                onChange={() => change({ correctAnswer: [option.key] })}>{q.type === 'TRUE_FALSE' ? option.content : option.key}</Radio>}
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 8 }} aria-label={label(`选项 ${option.key}`)} value={option.content} maxLength={4000} placeholder={`选项 ${option.key}`} disabled={disabled || q.type === 'TRUE_FALSE'}
            onChange={(content) => change({ options: q.options.map((o, i) => i === index ? { ...o, content } : o), correctAnswer: content.trim() ? q.correctAnswer : q.correctAnswer.filter((a) => a !== option.key) })} />
          {q.type !== 'TRUE_FALSE' && <Button type="text" status="danger" icon={<IconDelete />} disabled={disabled || q.options.length <= 2} aria-label={label(`删除选项 ${option.key}`)}
            onClick={() => change({ options: q.options.filter((_, i) => i !== index).map((o, i) => ({ ...o, key: String.fromCharCode(65 + i) })), correctAnswer: [] })} />}
        </div>{fieldPreview(option.content)}</div>)}
        {q.type !== 'TRUE_FALSE' && <Button type="dashed" long icon={<IconPlus />} disabled={disabled || q.options.length >= 26}
          onClick={() => change({ options: [...q.options, { key: String.fromCharCode(65 + q.options.length), content: '' }] })}>添加选项</Button>}
      </div>

    </>}
    {q.type === 'FILL_BLANK' && <>
      <Divider orientation="left">空位与可接受答案</Divider>
      {(q.blanks ?? []).map((blank, index) => <div className="bw-blank-card" key={index}>
        <div className="bw-sub-heading"><strong>第 {index + 1} 空 <Tag>{`{{${index + 1}}}`}</Tag></strong>
          <Button type="text" status="danger" icon={<IconDelete />} aria-label={label(`移除第${index + 1}空`)} disabled={disabled || (q.blanks?.length ?? 0) <= 1}
            onClick={() => change({ blanks: q.blanks?.filter((_, i) => i !== index), stem: q.stem.replace(/\{\{(\d+)\}\}/g, (match, number: string, offset: number) => q.stem[offset - 1] === '\\' ? match : Number(number) === index + 1 ? '' : Number(number) > index + 1 ? `{{${Number(number) - 1}}}` : match) })} />
        </div>
        <Form.Item label={label(`第${index + 1}空可接受答案`)} required extra="每行一个答案，学生填写任意一个即可匹配。">
          <Input.TextArea aria-label={label(`第${index + 1}空可接受答案`)} value={blank.answers.join('\n')} disabled={disabled} placeholder={'例如：H₂O\nH2O'} autoSize={{ minRows: 2, maxRows: 5 }}
            onChange={(text) => change({ blanks: q.blanks?.map((b, i) => i === index ? { answers: text.split('\n') } : b) })} />
        </Form.Item>
      </div>)}
      <Button long type="dashed" icon={<IconPlus />} disabled={disabled || (q.blanks?.length ?? 0) >= 20} onClick={() => change({ blanks: [...q.blanks ?? [], { answers: [] }], stem: `${q.stem} {{${(q.blanks?.length ?? 0) + 1}}}` })}>添加空位</Button>
      <Form.Item label="答案判定设置" className="section-gap"><Space wrap>
        <Checkbox disabled={disabled} checked={q.blankMatch?.ignoreCase ?? true} onChange={(ignoreCase) => change({ blankMatch: { trimWhitespace: q.blankMatch?.trimWhitespace ?? true, ignoreCase } })}>忽略英文字母大小写</Checkbox>
        <Checkbox disabled={disabled} checked={q.blankMatch?.trimWhitespace ?? true} onChange={(trimWhitespace) => change({ blankMatch: { ignoreCase: q.blankMatch?.ignoreCase ?? true, trimWhitespace } })}>忽略首尾空格</Checkbox>
      </Space></Form.Item>
    </>}
    {q.type === 'SHORT_ANSWER' && <>
      <Alert type="info" className="bw-form-error" content="本题不计分。交卷后展示参考内容，可标记掌握或待复习。" />
      <Form.Item label={label(q.presentation === 'CODE_WRITING' ? '参考实现' : '参考思路')} required><Input.TextArea aria-label={label(q.presentation === 'CODE_WRITING' ? '参考实现' : '参考思路')} disabled={disabled} value={q.referenceAnswer ?? ''} onChange={(referenceAnswer) => change({ referenceAnswer })} placeholder="填写完整的参考作答" maxLength={40000} showWordLimit autoSize={{ minRows: 4, maxRows: 10 }} />{fieldPreview(q.referenceAnswer)}</Form.Item>
      <Form.Item label={label('参考要点')} extra="选填，每条支持 Markdown，最多 1000 字，共 30 条。">
        <Space direction="vertical" style={{ width: '100%' }}>
          {(q.scoringPoints || []).map((point, index) => <div className="option-row" key={index}>
            <Input.TextArea aria-label={label(`参考要点 ${index + 1}`)} disabled={disabled} value={point} maxLength={1000} autoSize={{ minRows: 2, maxRows: 8 }} onChange={text => change({ scoringPoints: q.scoringPoints?.map((value, i) => i === index ? text : value) })} />
            <Button type="text" status="danger" icon={<IconDelete />} aria-label={label(`移除参考要点 ${index + 1}`)} disabled={disabled} onClick={() => change({ scoringPoints: q.scoringPoints?.filter((_, i) => i !== index) })} />
          </div>)}
          <Button type="dashed" icon={<IconPlus />} disabled={disabled || (q.scoringPoints?.length || 0) >= 30} onClick={() => change({ scoringPoints: [...q.scoringPoints || [], ''] })}>添加参考要点</Button>
        </Space>
      </Form.Item>
    </>}
    {q.type === 'READING' && <>
      <Form.Item label="阅读材料" required extra="所有小题共用此材料，支持保留段落。">{insertButton('passage')}<Input.TextArea aria-label="阅读材料" disabled={disabled} value={q.passage ?? ''} onChange={(passage) => change({ passage })} placeholder="粘贴文章、案例或分析材料" maxLength={20000} showWordLimit autoSize={{ minRows: 6, maxRows: 14 }} />{fieldPreview(q.passage)}</Form.Item>
      <Alert type="info" content="阅读材料不计题数，按下方小题统计。小题随题组统一管理章节与启用状态。" />
      <Divider orientation="left">阅读小题 · {subQuestions.length} 道</Divider>
      {subQuestions.map((sub, index) => <section className="bw-reading-sub" key={sub.id}>
        <div className="bw-sub-heading"><strong>小题 {index + 1}</strong><Space size={0}>
          <Button type="text" icon={<IconArrowUp />} aria-label={`上移小题${index + 1}`} disabled={disabled || index === 0} onClick={() => moveSub(index, -1)} />
          <Button type="text" icon={<IconArrowDown />} aria-label={`下移小题${index + 1}`} disabled={disabled || index === subQuestions.length - 1} onClick={() => moveSub(index, 1)} />
          <Button type="text" status="danger" icon={<IconDelete />} aria-label={`移除小题${index + 1}`} disabled={disabled} onClick={() => removeSub(sub)} />
        </Space></div>
        <QuestionContentEditor value={sub} onChange={(next) => updateSub(sub.id, next)} disabled={disabled} allowReading={false} prefix={`小题${index + 1}`} bankId={bankId} onBusyChange={onBusyChange} />
      </section>)}
      {!subQuestions.length && <p className="empty-note">先选择小题题型，再添加第一道小题。</p>}
      <div className="bw-add-sub"><Select aria-label="新增小题题型" value={newSubType} disabled={disabled} onChange={setNewSubType} options={Object.entries(questionTypeLabels).filter(([type]) => type !== 'READING').map(([value, label]) => ({ value, label }))} />
        <Button type="dashed" icon={<IconPlus />} disabled={disabled || subQuestions.length >= 50} onClick={() => change({ subQuestions: [...subQuestions, { ...createQuestionContent(newSubType) as AtomicQuestionContent, id: crypto.randomUUID() }] })}>添加小题</Button></div>
    </>}
    <Form.Item label={label(q.type === 'READING' ? '材料说明（选填）' : '答案解析（发布前必填）')} className="section-gap">
      <Input.TextArea aria-label={label(q.type === 'READING' ? '材料说明' : '答案解析')} value={q.explanation} disabled={disabled} onChange={(explanation) => change({ explanation })} placeholder={q.type === 'READING' ? '可补充文章背景或材料导读；每道小题分别填写解析' : '说明正确答案及解题思路'} maxLength={10000} showWordLimit autoSize={{ minRows: 3, maxRows: 24 }} />
      {fieldPreview(q.explanation)}
    </Form.Item>
    <Form.Item label={label(q.type === 'READING' ? '材料图片附件' : '题目图片附件')} extra="PNG、JPEG、WebP，每张最多 5 MiB"><QuestionImages ids={q.assetIds} bankId={bankId} disabled={disabled} picker={picker} onGalleryAdd={() => { selection.current = null }} references={references} onChange={assetIds => {
        const pos = selection.current
        selection.current = null
        if (!pos || assetIds.length <= (q.assetIds?.length ?? 0)) return change({assetIds})
        const text = q[pos.field] || ''
        change({assetIds, [pos.field]: text.slice(0,pos.start) + assetIds.slice(q.assetIds?.length ?? 0).map((id, index) => `![图${(q.assetIds?.length ?? 0) + index + 1}](asset:${id})`).join('\n') + text.slice(pos.end)})
      }} onBusyChange={onBusyChange} /></Form.Item>
  </div>
}
