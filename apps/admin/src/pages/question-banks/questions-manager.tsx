import { useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Button, Dropdown, Empty, Input, Menu, Message, Select, Space, Table, Tag } from '@arco-design/web-react'
import { IconMinus, IconPlus, IconUpload } from '@arco-design/web-react/icon'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import { questionTypeLabels } from '../../lib/labels'
import { answerSummary, missingExplanations } from '../../lib/question-content'
import { ErrorState } from '../../components/error-state'
import type { QuestionType, Chapter, CreateQuestionInput, Question, QuestionBank } from '../../types/admin'
import { parseContent, type ContentNode } from '@qanda/content-format'
import { QuestionFormDrawer } from '../questions/question-form-drawer'
import { refreshWorkbench } from './workbench-data'

function listStem(question: Question) {
  if (question.contentFormat !== 'MARKDOWN' || !question.stem.includes('](asset:')) return question.stem
  const numbers = new Map<string, number>()
  function text(node: ContentNode): string {
    if (node.assetId) {
      if (!numbers.has(node.assetId)) numbers.set(node.assetId, numbers.size + 1)
      return '[图' + numbers.get(node.assetId) + ']'
    }
    return node.text ?? node.children?.map(text).join('') ?? ''
  }
  return parseContent(question.stem, question.contentFormat).map(text).join(' ')
}

export function QuestionsManager({ bank, chapters, chapterId, onImport, newChapter }: {
  newChapter: (afterCreate: (id: string) => void, bankId: string, count: number) => void
  bank: QuestionBank
  chapters: Chapter[]
  chapterId?: string
  onImport: (file?: File) => void
}) {
  const gateway = useAdminGateway()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const keyword = params.get('keyword') ?? ''
  const requestedType = params.get('type') ?? ''
  const type = Object.prototype.hasOwnProperty.call(questionTypeLabels, requestedType) ? requestedType as QuestionType : 'ALL'
  const requestedStatus = params.get('status')
  const status = requestedStatus === 'ACTIVE' || requestedStatus === 'INACTIVE' ? requestedStatus : 'ALL'
  const requestedPage = Number(params.get('page'))
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  function applyFilters(changes: Record<string, string>) {
    // BrowserRouter can still be rendering the previous chapter when typing starts.
    const next = new URLSearchParams(window.location.search)
    if (!('page' in changes)) next.delete('page')
    for (const [key, value] of Object.entries(changes)) {
      if (value && value !== 'ALL') next.set(key, value)
      else next.delete(key)
    }
    setParams(next, { state: location.state, replace: 'keyword' in changes })
  }
  const query = useQuery({ queryKey: ['questions', bank.id, chapterId, keyword, type, status, page], queryFn: () => gateway.listQuestions({ questionBankId: bank.id, chapterId: chapterId === 'unassigned' ? undefined : chapterId, unassigned: chapterId === 'unassigned', keyword, type: type === 'ALL' ? undefined : type, status: status === 'ALL' ? undefined : status, page }) })
  const [editing, setEditing] = useState<Question | null | undefined>()
  const [preview, setPreview] = useState(false)
  const save = useMutation({
    mutationFn: (input: CreateQuestionInput) => editing ? gateway.updateQuestion(editing.id, { ...input, expectedVersion: editing.version }) : gateway.createQuestion(input),
    onSuccess: () => { refreshWorkbench(client); Message.success('题目已保存') },
    onError: error => Message.error(error.message),
  })
  const changeStatus = useMutation({
    mutationFn: async (question: Question) => {
      if (question.status === 'ACTIVE') await gateway.deactivateQuestion(question.id, question.version)
      else await gateway.updateQuestion(question.id, { ...question, expectedVersion: question.version, status: 'ACTIVE' })
    },
    onSuccess: () => { refreshWorkbench(client); Message.success('题目状态已更新') },
    onError: (error) => Message.error(error.message),
  })
  const rows = query.data?.items ?? []
  const openEditor = (question: Question | null, preview = false) => { setPreview(preview); save.reset(); setEditing(question) }
  return <div id="bank-questions" className="bw-questions-panel" onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault() }} onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length === 1) onImport(e.dataTransfer.files[0]); else Message.error("请拖入一个 ZIP 题包") }}>
    <div className="bw-question-filters">
      <Input.Search aria-label="搜索题目" value={keyword} onChange={value => applyFilters({ keyword: value })} allowClear placeholder="搜索题干、选项或阅读材料" /><Select aria-label="筛选题型" value={type} onChange={value => applyFilters({ type: value })} options={[{ label: '全部题型', value: 'ALL' }, ...Object.entries(questionTypeLabels).map(([value, label]) => ({ value, label }))]} /><Select aria-label="筛选题目状态" value={status} onChange={value => applyFilters({ status: value })} options={[{ label: '全部状态', value: 'ALL' }, { label: '已启用', value: 'ACTIVE' }, { label: '已停用', value: 'INACTIVE' }]} />
      <div className="question-create-tools"><Button icon={<IconUpload />} onClick={() => onImport()}>导入 ZIP</Button><Button type="primary" icon={<IconPlus />} onClick={() => openEditor(null)}>新建题目</Button></div>
    </div>
    {type !== 'ALL' && type !== 'READING' && <p className="bw-form-note">阅读题组包含所选题型时会一并显示，可展开查看小题。</p>}
    {query.error && <ErrorState stale={!!query.data} message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<Question> rowKey="id" data={rows} border={false} loading={query.isFetching} scroll={{ x: 610 }} pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: value => applyFilters({ page: String(value) }), showTotal: true }}
      expandProps={{ rowExpandable: (q) => q.type === 'READING', icon: ({ expanded, record }) => <button type="button" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}阅读小题 ${record.stem}`}>{expanded ? <IconMinus /> : <IconPlus />}</button> }} expandedRowRender={rows.some(q => q.type === 'READING') ? (q) => <div className="bw-reading-preview"><p>{q.passage}</p><ol>{q.subQuestions?.map((sub) => <li key={sub.id}><Tag>{questionTypeLabels[sub.type]}</Tag><span>{sub.stem}</span></li>)}</ol><Button type="text" onClick={() => openEditor(q, true)}>查看完整题组与答案</Button></div> : undefined} columns={[
      { title: '题目内容', render: (_, question) => <button className="bw-question-stem" onClick={() => openEditor(question)}><strong>{listStem(question)}</strong><small>{answerSummary(question)} · v{question.revision ?? 1}{missingExplanations([question]) > 0 && ' · 解析待补充'}</small></button> },
      { title: '题型', width: 96, render: (_, question) => <Tag color={question.type === 'READING' ? 'purple' : question.type === 'SHORT_ANSWER' ? 'orange' : question.type === 'FILL_BLANK' ? 'green' : 'arcoblue'}>{questionTypeLabels[question.type]}</Tag> },
      { title: '章节', width: 96, render: (_, question) => <span className="bw-question-chapter">{chapters.find((c) => c.id === question.chapterId)?.name ?? '未分章'}</span> },
      { title: '状态', width: 85, render: (_, question) => <Tag color={question.status === 'ACTIVE' ? 'green' : 'gray'}>{question.status === 'ACTIVE' ? '已启用' : '已停用'}</Tag> },
      { title: '操作', width: 104, render: (_, question) => <Space size={0}><Button type="text" size="small" onClick={() => openEditor(question, true)}>预览</Button><Dropdown trigger="click" droplist={<Menu onClickMenuItem={(key) => {
        if (key === 'status') changeStatus.mutate(question)
      }}><Menu.Item key="status" disabled={changeStatus.isPending}>{question.status === 'ACTIVE' ? '停用题目' : '启用题目'}</Menu.Item></Menu>}><Button type="text" size="small" aria-label={`更多题目操作 ${question.stem}`}>更多</Button></Dropdown></Space> },
    ]} noDataElement={<div className="bw-table-empty"><Empty description={query.error ? '题目加载失败' : keyword || type !== 'ALL' || status !== 'ALL' || chapterId ? '没有符合条件的题目' : '还没有题目，可以手动录入或批量导入'} />{!query.error && (keyword || type !== 'ALL' || status !== 'ALL' ? <Button onClick={() => applyFilters({ keyword: '', type: '', status: '' })}>清空筛选</Button> : <Button onClick={() => openEditor(null)}>新建第一道题目</Button>)}</div>} />
    {editing !== undefined && <QuestionFormDrawer key={editing?.id ?? 'new'} newChapter={newChapter} visible initialPreview={preview} editing={editing} questionBanks={[bank]} defaultQuestionBankId={bank.id}
      defaultChapterId={chapterId === 'unassigned' ? undefined : chapterId} saving={save.isPending} error={save.error?.message}
      onCancel={() => { save.reset(); setEditing(undefined) }} onSave={input => { if (!save.isPending) save.mutate(input, { onSuccess: () => setEditing(undefined) }) }} />}
  </div>
}
