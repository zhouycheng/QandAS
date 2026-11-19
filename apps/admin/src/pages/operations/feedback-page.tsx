import { useState } from 'react'
import { Alert, Button, Form, Input, Message, Select } from '@arco-design/web-react'
import { IconMessage } from '@arco-design/web-react/icon'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useAdminGateway } from '../../gateways/gateway-context'
import { feedbackStatusLabels, courseRequestStatusLabels } from '../../lib/recommendations'
import type { StudentFeedback } from '../../types/operations'
import { QuestionContentView } from '../questions/question-content-view'

const kinds = { QUESTION: '题目纠错', COURSE_REQUEST: '缺课需求' } as const

function useFeedbackList(kind: StudentFeedback['kind'], status: string | undefined, enabled: boolean) {
  const gateway = useAdminGateway()
  return useInfiniteQuery({
    queryKey: ['feedback', 'inbox', kind, status], enabled, initialPageParam: 1,
    queryFn: ({ pageParam }) => gateway.listFeedback({ kind, status, page: pageParam }),
    getNextPageParam: last => last.page * last.pageSize < last.total ? last.page + 1 : undefined,
  })
}

export function FeedbackPage() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('kind')
  const kind = requested === 'QUESTION' || requested === 'COURSE_REQUEST' ? requested : undefined
  const raw = params.get('status') ?? ''
  const status = raw === 'PENDING' || Object.hasOwn(feedbackStatusLabels, raw) ? raw : undefined
  const questions = useFeedbackList('QUESTION', status, kind !== 'COURSE_REQUEST')
  const courses = useFeedbackList('COURSE_REQUEST', status, kind !== 'QUESTION')
  const lists = kind === 'QUESTION' ? [questions] : kind === 'COURSE_REQUEST' ? [courses] : [questions, courses]
  const rows = lists.flatMap(list => list.data?.pages.flatMap(page => page.items) ?? [])
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
  const total = lists.every(list => list.data) ? lists.reduce((sum, list) => sum + list.data!.pages[0].total, 0) : undefined
  const labels = kind === 'COURSE_REQUEST' ? courseRequestStatusLabels : kind === 'QUESTION' ? feedbackStatusLabels
    : { OPEN: '待处理 / 待评估', IN_PROGRESS: '处理中 / 整理中', RESOLVED: '已解决 / 已补充', DISMISSED: '无需修改 / 暂不收录' }
  function filter(key: string, value?: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next)
  }
  return <section className="op-inbox op-sheet" aria-label="学生反馈">
    <header className="op-toolbar"><h2>反馈收件箱 {total !== undefined && <small>{total}</small>}</h2>
      <div className="op-filters"><Select aria-label="反馈类型" value={kind ?? ''} onChange={v => filter('kind', v)}
        options={[{ value: '', label: '全部类型' }, ...Object.entries(kinds).map(([value,label]) => ({ value,label }))]} />
        <Select aria-label="处理状态" value={status ?? ''} onChange={v => filter('status', v)} options={Object.entries({ '': '全部状态', PENDING: '待处理及处理中', ...labels }).map(([value,label]) => ({ value,label }))} /></div>
    </header>
    {lists.map((list, index) => list.error && <Alert key={index} type="warning" content={list.error.message} action={<Button onClick={() => void list.refetch()}>重试</Button>} />)}
    {lists.some(list => list.isPending) && <p role="status">正在读取反馈…</p>}
    {total === 0 && <div className="op-empty"><IconMessage /><strong>{kind || status ? '暂无符合条件的反馈' : '还没有学生反馈'}</strong>{(kind || status) && <Button type="text" onClick={() => setParams({})}>清除筛选</Button>}</div>}
    {rows.map(row => <FeedbackItem key={row.kind + row.id} record={row} />)}
    {lists.some(list => list.hasNextPage) && <Button loading={lists.some(list => list.isFetchingNextPage)} onClick={() => lists.forEach(list => { if (list.hasNextPage) void list.fetchNextPage() })}>加载更多反馈</Button>}
  </section>
}

function FeedbackItem({ record }: { record: StudentFeedback }) {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [draft, setDraft] = useState<Pick<StudentFeedback, 'status' | 'response' | 'version'>>()
  const current = draft ?? record
  const labels = record.kind === 'QUESTION' ? feedbackStatusLabels : courseRequestStatusLabels
  const save = useMutation({
    mutationFn: () => gateway.updateFeedback({ ...record, version: current.version }, { status: current.status, response: current.response }),
    onSuccess: async () => {
      await Promise.all(['feedback', 'dashboard-summary'].map(key => client.invalidateQueries({ queryKey: [key] })))
      setDraft(undefined)
      Message.success('处理结果已保存')
    },
  })
  const needsReply = ['RESOLVED','DISMISSED'].includes(current.status) && !current.response.trim()
  return <article className="op-letter op-feedback-item">
    <header className="op-meta">
      <strong>{kinds[record.kind]}</strong>
      <span className="op-feedback-status" data-status={record.status}>{labels[record.status]}</span>
      <time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
    </header>
    {!record.questionSnapshot && record.title && <h3>{record.title}</h3>}
    {record.body && <p className="op-letter-body">{record.body}</p>}
    {record.questionSnapshot && <div className="op-snapshot"><strong>提交反馈时的题目</strong><QuestionContentView question={record.questionSnapshot} /></div>}
    <Form className="op-reply" layout="vertical" disabled={save.isPending} onSubmit={() => save.mutate()}>
      <div className="op-reply-line">
        <Input.TextArea aria-label="回复学生" placeholder="回复学生…" maxLength={2000} value={current.response}
          onChange={response => setDraft({ status: current.status, version: current.version, response })} autoSize={{ minRows: 1 }} />
        <div className="op-actions">
          <Select aria-label="更新处理状态" value={current.status} onChange={status => setDraft({ status, version: current.version, response: current.response })} options={Object.entries(labels).map(([value,label]) => ({ value,label }))} />
          <Button type="primary" htmlType="submit" loading={save.isPending} disabled={!draft || needsReply}>保存并回复</Button>
        </div>
      </div>
      {needsReply && <small role="status">结束处理前请填写回复。</small>}
      {save.error && <Alert type="error" content={save.error.message} />}
    </Form>
  </article>
}
