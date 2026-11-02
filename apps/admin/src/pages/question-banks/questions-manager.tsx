import { useEffect, useState } from 'react'
import { Button, Dropdown, Empty, Input, Menu, Message, Select, Space, Table, Tag } from '@arco-design/web-react'
import { IconMinus, IconPlus, IconUpload } from '@arco-design/web-react/icon'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import { questionTypeLabels } from '../../lib/labels'
import { answerSummary, missingExplanations } from '../../lib/question-content'
import { ErrorState } from '../../components/error-state'
import type { ContentStatus, QuestionType, Chapter, CreateQuestionInput, Question, QuestionBank } from '../../types/admin'
import { QuestionDetailDrawer } from '../questions/question-detail-drawer'
import { QuestionFormDrawer } from '../questions/question-form-drawer'
import { refreshWorkbench } from './workbench-data'

export function QuestionsManager({ bank, chapters, chapterId, onImport }: {
  bank: QuestionBank
  chapters: Chapter[]
  chapterId?: string
  onImport: () => void
}) {
  const gateway = useAdminGateway()
  const client = useQueryClient()
  const [keyword, setKeyword] = useState('')
  const [type, setType] = useState('ALL')
  const [status, setStatus] = useState('ALL')
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [keyword, type, status, chapterId])
  const query = useQuery({ queryKey: ['questions', bank.id, chapterId, keyword, type, status, page], queryFn: () => gateway.listQuestions({ questionBankId: bank.id, chapterId: chapterId === 'unassigned' ? undefined : chapterId, unassigned: chapterId === 'unassigned', keyword, type: type === 'ALL' ? undefined : type as QuestionType, status: status === 'ALL' ? undefined : status as ContentStatus, page }) })
  const [editing, setEditing] = useState<Question | null | undefined>()
  const [detailId, setDetailId] = useState<string>()
  const save = useMutation({
    mutationFn: (input: CreateQuestionInput) => editing ? gateway.updateQuestion(editing.id, { ...input, expectedVersion: editing.version }) : gateway.createQuestion(input),
    onSuccess: () => { setEditing(undefined); refreshWorkbench(client); Message.success('题目已保存') },
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
  const openEditor = (question: Question | null) => { save.reset(); setEditing(question) }
  return <div className="bw-questions-panel">
    <div className="bw-panel-heading"><div><h2>{chapterId === 'unassigned' ? '未分章题目' : chapters.find((c) => c.id === chapterId)?.name ?? '全部题目'}</h2><p>共 {query.data?.total ?? 0} 条题目记录；阅读题组展开显示小题。</p></div><Space wrap><Button icon={<IconUpload />} onClick={onImport}>批量导入</Button><Button type="primary" icon={<IconPlus />} onClick={() => openEditor(null)}>新建题目</Button></Space></div>
    <div className="bw-question-filters"><Input.Search aria-label="搜索题目" value={keyword} onChange={setKeyword} allowClear placeholder="搜索题干、选项或阅读材料" /><Select aria-label="筛选题型" value={type} onChange={setType} options={[{ label: '全部题型', value: 'ALL' }, ...Object.entries(questionTypeLabels).map(([value, label]) => ({ value, label }))]} /><Select aria-label="筛选题目状态" value={status} onChange={setStatus} options={[{ label: '全部状态', value: 'ALL' }, { label: '已启用', value: 'ACTIVE' }, { label: '已停用', value: 'INACTIVE' }]} /></div>
    {type !== 'ALL' && type !== 'READING' && <p className="bw-form-note">阅读题组包含所选题型时会一并显示，可展开查看小题。</p>}
    {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<Question> rowKey="id" data={rows} border={false} loading={query.isFetching} scroll={{ x: 830 }} pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: setPage, showTotal: true }}
      expandProps={{ rowExpandable: (q) => q.type === 'READING', icon: ({ expanded, record }) => <button type="button" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}阅读小题 ${record.stem}`}>{expanded ? <IconMinus /> : <IconPlus />}</button> }} expandedRowRender={(q) => q.type === 'READING' ? <div className="bw-reading-preview"><p>{q.passage}</p><ol>{q.subQuestions?.map((sub) => <li key={sub.id}><Tag>{questionTypeLabels[sub.type]}</Tag><span>{sub.stem}</span></li>)}</ol><Button type="text" onClick={() => setDetailId(q.id)}>查看完整题组与答案</Button></div> : null} columns={[
      { title: '题型', width: 95, render: (_, question) => <Tag color={question.type === 'READING' ? 'purple' : question.type === 'SHORT_ANSWER' ? 'orange' : question.type === 'FILL_BLANK' ? 'green' : 'arcoblue'}>{questionTypeLabels[question.type]}</Tag> },
      { title: '题目内容', width: 310, render: (_, question) => <button className="bw-question-stem" onClick={() => setDetailId(question.id)}><strong>{question.stem}</strong><small>{answerSummary(question)} · v{question.revision ?? 1}{missingExplanations([question]) > 0 && ' · 解析待补充'}</small></button> },
      { title: '章节', width: 125, render: (_, question) => <span className="bw-question-chapter">{chapters.find((c) => c.id === question.chapterId)?.name ?? '未分章'}</span> },
      { title: '状态', width: 85, render: (_, question) => <Tag color={question.status === 'ACTIVE' ? 'green' : 'gray'}>{question.status === 'ACTIVE' ? '已启用' : '已停用'}</Tag> },
      { title: '操作', width: 185, render: (_, question) => <Space size={0}><Button type="text" size="small" onClick={() => setDetailId(question.id)}>查看</Button><Button type="text" size="small" onClick={() => openEditor(question)}>编辑</Button><Dropdown trigger="click" droplist={<Menu onClickMenuItem={(key) => {
        if (key === 'status') changeStatus.mutate(question)
      }}><Menu.Item key="status" disabled={changeStatus.isPending}>{question.status === 'ACTIVE' ? '停用题目' : '启用题目'}</Menu.Item></Menu>}><Button type="text" size="small" aria-label={`更多题目操作 ${question.stem}`}>更多</Button></Dropdown></Space> },
    ]} noDataElement={<div className="bw-table-empty"><Empty description={query.data?.total ? '没有符合条件的题目' : '还没有题目，可以手动录入或批量导入'} />{query.data?.total ? <Button onClick={() => { setKeyword(''); setType('ALL'); setStatus('ALL') }}>清空筛选</Button> : <Button onClick={() => openEditor(null)}>新建第一道题目</Button>}</div>} />
    <div className="bw-panel-foot">修改题目后，新练习使用更新后的内容；已有练习和反馈保留原题。</div>
    {editing !== undefined && <QuestionFormDrawer visible editing={editing} chapters={chapters} questionBanks={[bank]} lockBank defaultQuestionBankId={bank.id}
      defaultChapterId={chapterId === 'unassigned' ? undefined : chapterId} saving={save.isPending} error={save.error?.message} onCancel={() => setEditing(undefined)} onSave={(input) => { if (!save.isPending) save.mutate(input) }} />}
    <QuestionDetailDrawer questionId={detailId} questionBanks={[bank]} onClose={() => setDetailId(undefined)} />
  </div>
}
