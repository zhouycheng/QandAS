import { ManagementDrawer as Drawer } from '../../components/management-drawer'
import { ResourceSelect } from '../../components/resource-select'
import { useQuery } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import { QuestionContentView } from './question-content-view'
import { useRef, useState } from 'react'
import { Alert, Button, Form, Message, Radio, Select, Space } from '@arco-design/web-react'
import { validateQuestion } from '../../lib/content-rules'
import { contentFingerprint, createQuestionContent, cleanDraft } from '../../lib/question-content'
import { closeDraft, formHasChanges } from '../../lib/unsaved-changes'
import type { ContentStatus, CreateQuestionInput, Question, QuestionBank, QuestionContent } from '../../types/admin'
import { QuestionContentEditor } from './question-content-editor'

interface Metadata { questionBankId: string; chapterId?: string; status: ContentStatus }

export function QuestionFormDrawer({ visible, editing, newChapter, questionBanks, saving, error, onCancel, onSave, defaultQuestionBankId, defaultChapterId, initialPreview = false }: {
  newChapter: (afterCreate: (id: string) => void, bankId: string, count: number) => void
  defaultQuestionBankId?: string
  defaultChapterId?: string
  initialPreview?: boolean
  visible: boolean
  editing: Question | null
  questionBanks: QuestionBank[]
  saving: boolean
  error?: string
  onCancel: () => void
  onSave: (input: CreateQuestionInput) => void
}) {
  const [form] = Form.useForm<Metadata>()
  const [initialContent] = useState<QuestionContent>(() => editing ?? createQuestionContent())
  const [content, setContent] = useState(initialContent)
  const [initialMetadata] = useState<Metadata>(() => ({
    questionBankId: editing?.questionBankId ?? defaultQuestionBankId ?? questionBanks[0]?.id,
    chapterId: editing?.chapterId ?? defaultChapterId, status: editing?.status ?? 'ACTIVE',
  }))
  const gateway = useAdminGateway()
  const [bankId, setBankId] = useState(initialMetadata.questionBankId)
  const chapters = useQuery({ queryKey: ['chapters', bankId], enabled: !!bankId, queryFn: () => gateway.listChapters(bankId!) })
  const [preview, setPreview] = useState(initialPreview)
  const previewPane = useRef<HTMLElement>(null)
  const [previewStage, setPreviewStage] = useState<'answer' | 'feedback' | 'review'>('review')
  const [uploads, setUploads] = useState(0)
  const busy = saving || uploads > 0
  const [validationError, setValidationError] = useState('')
  const submit = (metadata: Metadata) => {
    if (busy) return
    try { onSave(validateQuestion({ ...cleanDraft(content), ...metadata })) }
    catch (error) { const message = (error as Error).message; setValidationError(message); Message.error(message) }
  }
  const cancel = () => {
    if (saving) return onCancel()
    closeDraft(uploads > 0 || formHasChanges(initialMetadata, form.getFieldsValue()) ||
      contentFingerprint(content) !== contentFingerprint(initialContent), onCancel)
  }
  return <Drawer width="min(1240px, 100vw)" style={{ maxWidth: '100vw' }} className="bw-question-editor"
    title={editing ? (content.type === 'READING' ? '编辑阅读题组' : '编辑题目') : '新建题目'} visible={visible} afterOpen={() => { if (initialPreview) previewPane.current?.focus() }} onCancel={cancel} unmountOnExit
    footer={<Space><Button className="question-view-toggle" onClick={() => setPreview(!preview)}>{preview ? '继续编辑' : '完整预览'}</Button><Button onClick={cancel}>取消</Button><Button type="primary" loading={busy} onClick={() => form.submit()}>{content.type === 'READING' ? '保存题组' : '保存题目'}</Button></Space>}>
    {(validationError || error) && <Alert type="error" content={validationError || error} className="bw-form-error" />}
    <div className={'question-panes' + (preview ? ' viewing-preview' : '')}>
    <div className="question-fields"><Form form={form} initialValues={initialMetadata} layout="vertical" onSubmit={submit} disabled={busy}>
      <div className="question-location"><Form.Item field="questionBankId" label="所属题库" rules={[{ required: true, message: '请选择题库' }]}><ResourceSelect kind="bank" placeholder="所属题库" disabled={busy} onChange={value => { setBankId(value as string); form.setFieldValue('chapterId', undefined) }} initialOptions={questionBanks.map(bank => ({ label: bank.name, value: bank.id }))} /></Form.Item>
      {chapters.error && <Alert type="error" content={chapters.error.message} />}
      <Form.Item shouldUpdate noStyle>{(values) => <Form.Item field="chapterId" label={<Space>所属章节<Button size="mini" type="text" disabled={busy || !bankId || !chapters.data} onClick={() => newChapter(id => form.setFieldValue('chapterId', id), bankId!, chapters.data!.length)}>＋ 新建章节</Button></Space>}><Select aria-label="所属章节" allowClear placeholder="未分章" options={(chapters.data ?? []).filter((c) => c.questionBankId === values.questionBankId).map((c) => ({ label: c.name, value: c.id }))} /></Form.Item>}</Form.Item></div>
      <Form.Item shouldUpdate noStyle>{values => <QuestionContentEditor value={content} onChange={(next) => { setContent(next); setValidationError('') }} disabled={busy} bankId={values.questionBankId} onBusyChange={delta => setUploads(count => count + delta)} />}</Form.Item>
      <Form.Item field="status" label="状态" rules={[{ required: true, message: '请选择状态' }]}><Radio.Group><Radio value="ACTIVE">启用</Radio><Radio value="INACTIVE">停用</Radio></Radio.Group></Form.Item>
    </Form></div>
    <aside className="question-preview" ref={previewPane} tabIndex={-1} aria-label="学生预览"><Radio.Group type="button" value={previewStage} onChange={setPreviewStage} options={[{ value: 'answer', label: '学生作答' }, { value: 'feedback', label: '即时反馈' }, { value: 'review', label: '交卷复盘' }]} /><QuestionContentView question={content} stage={previewStage} /></aside>
    </div>
  </Drawer>
}
