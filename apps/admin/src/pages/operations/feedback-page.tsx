import { useState } from 'react'
import { Alert, Button, Card, Drawer, Form, Input, Radio, Select, Space, Table, Tag } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import { feedbackStatusLabels, courseRequestStatusLabels } from '../../lib/recommendations'
import type { FeedbackStatus, StudentFeedback } from '../../types/operations'
import { QuestionContentView } from '../questions/question-content-view'

export function FeedbackPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const kind = params.get('kind') === 'COURSE_REQUEST' ? 'COURSE_REQUEST' : 'QUESTION'
  const [status, setStatus] = useState<FeedbackStatus>(), [page, setPage] = useState(1)
  const [editing, setEditing] = useState<StudentFeedback>()
  const query = useQuery({ queryKey: ['feedback', kind, status, page], queryFn: () => gateway.listFeedback({ kind, status, page }) })
  const labels = kind === 'QUESTION' ? feedbackStatusLabels : courseRequestStatusLabels
  return <section aria-label="学生反馈"><Space wrap>
    <Radio.Group type="button" value={kind} onChange={value => { setParams({ kind: value }); setPage(1) }}><Radio value="QUESTION">题目纠错</Radio><Radio value="COURSE_REQUEST">缺课需求</Radio></Radio.Group>
    <Select style={{ width: 150 }} aria-label="处理状态" placeholder="全部状态" value={status} allowClear options={Object.entries(labels).map(([value, label]) => ({ value, label }))} onChange={value => { setStatus(value); setPage(1) }} />
  </Space>{query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<StudentFeedback> rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: setPage }} columns={[
      { title: '题目 / 课程', dataIndex: 'title', ellipsis: true }, { title: '反馈内容', dataIndex: 'body', ellipsis: true }, { title: '状态', render: (_, row) => <Tag>{labels[row.status]}</Tag> }, { title: '提交时间', dataIndex: 'createdAt' }, { title: '操作', render: (_, row) => <Button type="text" onClick={() => setEditing(row)}>查看并处理</Button> },
    ]} />{editing && <FeedbackEditor record={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void client.invalidateQueries({ queryKey: ['feedback'] }); void client.invalidateQueries({ queryKey: ['dashboard-summary'] }) }} />}
  </section>
}

function FeedbackEditor({ record, onClose, onSaved }: { record: StudentFeedback; onClose: () => void; onSaved: () => void }) {
  const gateway = useAdminGateway()
  const [form] = Form.useForm<Pick<StudentFeedback, 'status' | 'response'>>()
  const save = useMutation({ mutationFn: (input: Pick<StudentFeedback, 'status' | 'response'>) => gateway.updateFeedback(record, input), onSuccess: onSaved })
  const labels = record.kind === 'QUESTION' ? feedbackStatusLabels : courseRequestStatusLabels
  return <Drawer visible title={record.title} width={720} maskClosable={false} onCancel={() => { if (!save.isPending) onClose() }} footer={<Button type="primary" loading={save.isPending} onClick={() => form.submit()}>保存并回复</Button>}>
    <p style={{ whiteSpace: 'pre-wrap' }}>{record.body}</p>{record.questionSnapshot && <Card title="提交反馈时的题目"><QuestionContentView question={record.questionSnapshot} /></Card>}
    {save.error && <Alert type="error" content={save.error.message} />}<Form form={form} layout="vertical" initialValues={{ status: record.status, response: record.response }} onSubmit={values => save.mutate(values)} disabled={save.isPending}>
      <Form.Item field="status" label="处理状态"><Select options={Object.entries(labels).map(([value, label]) => ({ value, label }))} /></Form.Item>
      <Form.Item field="response" label="给学生的处理结果" extra="结束处理前填写说明，学生可在反馈记录中查看。"><Input.TextArea maxLength={2000} showWordLimit autoSize={{ minRows: 4 }} /></Form.Item>
    </Form>
  </Drawer>
}
