import { useState } from 'react'
import { Alert, Button, Card, Checkbox, DatePicker, Drawer, Form, Input, InputNumber, Message, Modal, Radio, Select, Space, Switch, Table, Tag } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ErrorState } from '../../components/error-state'
import { ResourceSelect } from '../../components/resource-select'
import { UserDetailDrawer } from '../../components/user-detail-drawer'
import { AnnouncementBody } from '../../components/announcement-body'
import { useAdminGateway } from '../../gateways/gateway-context'
import { ApiError } from '../../gateways/api-error'
import { feedbackStatusLabels, courseRequestStatusLabels } from '../../lib/recommendations'
import { GRADE_OPTIONS, gradeLabel } from '../../types/admin'
import type { AdminAccount, AdminAccountInput, Announcement, AnnouncementInput, FeedbackStatus, LogQuery, ManagedUser, SecuritySettings, StudentFeedback, UserQuery } from '../../types/operations'
import { QuestionContentView } from '../questions/question-content-view'
import { CommunityGroupPreview } from './community-group-page'

export function UsersPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [filter, setFilter] = useState<UserQuery>({ page: 1 }), [id, setId] = useState<string>()
  const query = useQuery({ queryKey: ['users', filter], queryFn: () => gateway.listUsers(filter) })
  const save = useMutation({ mutationFn: (row: ManagedUser) => gateway.setUserStatus(row.id, row.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED', row.version), onSuccess: () => { void client.invalidateQueries({ queryKey: ['users'] }); Message.success('账号状态已更新') }, onError: error => Message.error(error.message) })
  const update = (patch: UserQuery) => setFilter({ ...filter, ...patch, page: 1 })
  return <section aria-label="用户管理"><Space wrap>
    <Input.Search aria-label="搜索用户" placeholder="昵称、账号或邮箱" value={filter.keyword} onChange={keyword => update({ keyword })} allowClear />
    <ResourceSelect kind="college" placeholder="全部学院" value={filter.collegeId} onChange={value => update({ collegeId: String(value || '') || undefined, majorId: undefined })} />
    <ResourceSelect kind="major" placeholder="全部专业" collegeId={filter.collegeId} value={filter.majorId} onChange={value => update({ majorId: String(value || '') || undefined })} />
    <Select aria-label="年级" style={{ width: 130 }} placeholder="全部年级" options={GRADE_OPTIONS} value={filter.grade} onChange={grade => update({ grade })} allowClear />
    <Select aria-label="账号状态" style={{ width: 140 }} placeholder="全部状态" value={filter.status} options={[{ label: '正常', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }, { label: '待激活', value: 'PENDING' }]} onChange={status => update({ status })} allowClear />
  </Space>{query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<ManagedUser> rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} scroll={{ x: 900 }} pagination={{ current: filter.page, pageSize: 20, total: query.data?.total ?? 0, onChange: page => setFilter({ ...filter, page }), showTotal: true }} columns={[
      { title: '昵称', render: (_, row) => <Button type="text" onClick={() => setId(row.id)}>{row.name}</Button> }, { title: '账号', dataIndex: 'account' }, { title: '学院', dataIndex: 'collegeName' }, { title: '专业', dataIndex: 'majorName' }, { title: '年级', render: (_, row) => gradeLabel(row.grade) }, { title: '状态', render: (_, row) => row.status === 'ACTIVE' ? '正常' : row.status === 'DISABLED' ? '停用' : '待激活' },
      { title: '操作', render: (_, row) => <Button type="text" status="warning" disabled={save.isPending || row.status === 'PENDING'} onClick={() => Modal.confirm({ title: row.status === 'DISABLED' ? '恢复账号？' : '停用账号？', content: '保留学习记录，停用后当前登录会话失效。', okText: '确认', cancelText: '取消', onOk: async () => {
        try { await save.mutateAsync(row) }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error
          await client.invalidateQueries({ queryKey: ['users'] })
        }
      } })}>{row.status === 'DISABLED' ? '恢复' : '停用'}</Button> },
    ]} />{id && <UserDetailDrawer id={id} onClose={() => setId(undefined)} />}
  </section>
}

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

export function AnnouncementsPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [page, setPage] = useState(1), [editing, setEditing] = useState<Announcement | null>(), [preview, setPreview] = useState<Announcement>()
  const query = useQuery({ queryKey: ['announcements', page], queryFn: () => gateway.listAnnouncements({ page }) })
  const labels = { DRAFT: '草稿', PUBLISHED: '已发布', SCHEDULED: '定时发布' }
  return <section aria-label="公告管理"><Button type="primary" onClick={() => setEditing(null)}>新建公告</Button>{query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<Announcement> rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: setPage }} columns={[
      { title: '标题', render: (_, row) => <Space>{row.pinned && <Tag color="blue">置顶</Tag>}{row.title}</Space> }, { title: '状态', render: (_, row) => labels[row.status] }, { title: '展示端', render: (_, row) => row.platforms.map(p => p === 'WEB' ? 'Web' : '小程序').join('、') }, { title: '发布时间', dataIndex: 'publishAt' },
      { title: '操作', render: (_, row) => <Space><Button type="text" onClick={() => setPreview(row)}>预览</Button><Button type="text" onClick={() => setEditing(row)}>编辑</Button><Button type="text" status="danger" onClick={() => Modal.confirm({ title: '删除公告？', content: '该公告将从用户端移除。', okText: '删除', cancelText: '取消', onOk: async () => { try { await gateway.deleteAnnouncement(row.id, row.version); void client.invalidateQueries({ queryKey: ['announcements'] }) } catch (error) { Message.error((error as Error).message); throw error } } })}>删除</Button></Space> },
    ]} />{editing !== undefined && <AnnouncementEditor record={editing ?? undefined} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void client.invalidateQueries({ queryKey: ['announcements'] }) }} />}
    <Modal visible={Boolean(preview)} title={preview?.title} footer={null} onCancel={() => setPreview(undefined)}>{preview && <><AnnouncementBody text={preview.body} />{preview.showCommunityGroup && <CommunityGroupPreview />}</>}</Modal>
  </section>
}
function AnnouncementEditor({ record, onClose, onSaved }: { record?: Announcement; onClose: () => void; onSaved: () => void }) {
  const gateway = useAdminGateway(), [form] = Form.useForm<AnnouncementInput>()
  const [audience, setAudience] = useState(record?.audience ?? 'ALL'), [status, setStatus] = useState(record?.status ?? 'DRAFT')
  const save = useMutation({ mutationFn: (input: AnnouncementInput) => gateway.saveAnnouncement(record?.id, { ...input, audience, status, userIds: audience === 'ALL' ? [] : input.userIds, publishAt: input.publishAt ? new Date(input.publishAt).toISOString() : undefined, expectedVersion: record?.version }), onSuccess: onSaved })
  return <Drawer visible title={record ? '编辑公告' : '新建公告'} width={680} maskClosable={false} onCancel={() => { if (!save.isPending) onClose() }} footer={<Button type="primary" loading={save.isPending} onClick={() => form.submit()}>保存公告</Button>}>
    {save.error && <Alert type="error" content={save.error.message} />}<Form form={form} layout="vertical" disabled={save.isPending} initialValues={record ?? { title: '', summary: '', body: '', audience: 'ALL', userIds: [], platforms: ['MINI_PROGRAM', 'WEB'], status: 'DRAFT' }} onSubmit={values => save.mutate(values)}>
      <Form.Item field="title" label="标题" rules={[{ required: true }]}><Input maxLength={80} /></Form.Item><Form.Item field="summary" label="摘要"><Input.TextArea maxLength={500} /></Form.Item>
      <Form.Item field="body" label="Markdown 正文" extra="支持代码块、表格和换行。发布前可在公告列表完整预览。"><Input.TextArea maxLength={40000} autoSize={{ minRows: 8 }} /></Form.Item>
      <Form.Item field="pinned" label="置顶公告" triggerPropName="checked"><Switch /></Form.Item>
      <Form.Item field="showCommunityGroup" label="展示交流群二维码" triggerPropName="checked" extra="使用“用户交流群”中维护的当前群码。"><Switch /></Form.Item>
      <Form.Item field="platforms" label="展示端"><Checkbox.Group options={[{ label: '小程序', value: 'MINI_PROGRAM' }, { label: '用户 Web', value: 'WEB' }]} /></Form.Item>
      <Form.Item label="发布范围"><Radio.Group value={audience} onChange={setAudience}><Radio value="ALL">全部学生</Radio><Radio value="SELECTED">指定学生</Radio></Radio.Group></Form.Item>
      {audience === 'SELECTED' && <Form.Item field="userIds" label="指定学生"><ResourceSelect kind="user" multiple placeholder="搜索并选择学生" /></Form.Item>}
      <Form.Item label="发布状态"><Radio.Group value={status} onChange={setStatus}><Radio value="DRAFT">草稿</Radio><Radio value="PUBLISHED">立即发布</Radio><Radio value="SCHEDULED">定时发布</Radio></Radio.Group></Form.Item>
      {status === 'SCHEDULED' && <Form.Item field="publishAt" label="发布时间" rules={[{ required: true }]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item>}
    </Form>
  </Drawer>
}

export function AdministratorsPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [page, setPage] = useState(1), [editing, setEditing] = useState<AdminAccount | null>()
  const query = useQuery({ queryKey: ['administrators', page], queryFn: () => gateway.listAdminAccounts({ page }) })
  return <section aria-label="管理员账号"><Button type="primary" onClick={() => setEditing(null)}>新增管理员</Button>{query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<AdminAccount> rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: setPage }} columns={[
      { title: '姓名', dataIndex: 'name' }, { title: '登录账号', dataIndex: 'username' }, { title: '身份', render: () => '超级管理员' }, { title: '状态', render: (_, row) => row.status === 'ACTIVE' ? '启用' : '停用' }, { title: '操作', render: (_, row) => <Button type="text" onClick={() => setEditing(row)}>编辑账号</Button> },
    ]} />{editing !== undefined && <AdminEditor record={editing ?? undefined} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void client.invalidateQueries({ queryKey: ['administrators'] }); void client.invalidateQueries({ queryKey: ['resource-select'] }) }} />}
  </section>
}
function AdminEditor({ record, onClose, onSaved }: { record?: AdminAccount; onClose: () => void; onSaved: () => void }) {
  const gateway = useAdminGateway(), [form] = Form.useForm<AdminAccountInput>()
  const save = useMutation({ mutationFn: (input: AdminAccountInput) => gateway.saveAdminAccount(record?.id, { ...input, password: input.password || undefined, expectedVersion: record?.version }), onSuccess: onSaved })
  return <Modal visible title={record ? '编辑管理员' : '新增管理员'} maskClosable={false} onCancel={() => { if (!save.isPending) onClose() }} confirmLoading={save.isPending} onOk={() => form.submit()} okText="保存" cancelText="取消">
    {save.error && <Alert type="error" content={save.error.message} />}<Form form={form} layout="vertical" disabled={save.isPending} initialValues={record ?? { status: 'ACTIVE' }} onSubmit={values => save.mutate(values)}>
      <Form.Item field="name" label="姓名" rules={[{ required: true }]}><Input maxLength={40} /></Form.Item><Form.Item field="username" label="登录账号" rules={[{ required: true }]}><Input maxLength={64} /></Form.Item>
      <Form.Item field="password" label={record ? '新密码（留空保持现有密码）' : '初始密码'} rules={[{ required: !record }]}><Input.Password autoComplete="new-password" /></Form.Item>
      <Form.Item field="status" label="状态"><Radio.Group><Radio value="ACTIVE">启用</Radio><Radio value="DISABLED">停用</Radio></Radio.Group></Form.Item>
      <p className="muted">管理员均可管理系统和其他管理员账号。</p>
    </Form>
  </Modal>
}

export function SecurityPage() {
  const gateway = useAdminGateway()
  const [editing, setEditing] = useState<SecuritySettings>()
  const query = useQuery({ queryKey: ['security'], queryFn: () => gateway.getSecuritySettings() })
  return <Card title="管理员登录与密码规则" extra={<Button disabled={!query.data} onClick={() => setEditing(query.data)}>编辑规则</Button>}>
    {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <p>登录失败锁定：{query.data?.lockEnabled ? '开启' : '关闭'}；失败次数 {query.data?.maxAttempts ?? '—'} 次，锁定 {query.data?.lockMinutes ?? '—'} 分钟。</p>
    <p>会话空闲期限：{query.data?.sessionMinutes ?? '—'} 分钟；密码至少 {query.data?.minPasswordLength ?? '—'} 位。</p>
    {editing && <SecurityEditor record={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void query.refetch() }} />}
  </Card>
}
function SecurityEditor({ record, onClose, onSaved }: { record: SecuritySettings; onClose: () => void; onSaved: () => void }) {
  const gateway = useAdminGateway(), [form] = Form.useForm<SecuritySettings>()
  const save = useMutation({ mutationFn: (input: SecuritySettings) => gateway.saveSecuritySettings({ ...input, version: record.version }), onSuccess: onSaved })
  return <Modal visible title="编辑安全规则" maskClosable={false} onCancel={() => { if (!save.isPending) onClose() }} onOk={() => form.submit()} confirmLoading={save.isPending} okText="保存" cancelText="取消">
    {save.error && <Alert type="error" content={save.error.message} />}<Form form={form} initialValues={record} layout="vertical" disabled={save.isPending} onSubmit={values => save.mutate(values)}>
      <Form.Item field="lockEnabled" label="失败锁定" triggerPropName="checked"><Switch /></Form.Item>
      {([['maxAttempts', '最大失败次数', 3, 10], ['lockMinutes', '锁定分钟数', 1, 1440], ['sessionMinutes', '会话空闲分钟数', 5, 1440], ['minPasswordLength', '最短密码长度', 12, 64]] as const).map(([field, label, min, max]) => <Form.Item key={field} field={field} label={label} rules={[{ required: true }]}><InputNumber min={min} max={max} precision={0} /></Form.Item>)}
      {([['requireLetter', '必须有字母'], ['requireNumber', '必须有数字'], ['requireMixedCase', '必须有大小写']] as const).map(([field, label]) => <Form.Item key={field} field={field} label={label} triggerPropName="checked"><Switch /></Form.Item>)}
    </Form>
  </Modal>
}

export function LogsPage() {
  const gateway = useAdminGateway(), [filter, setFilter] = useState<LogQuery>({ page: 1 })
  const query = useQuery({ queryKey: ['logs', filter], queryFn: () => gateway.listOperationLogs(filter) })
  return <section aria-label="操作日志"><Space wrap><Input.Search aria-label="搜索日志" placeholder="操作、原因或请求 ID" value={filter.keyword} onChange={keyword => setFilter({ ...filter, keyword, page: 1 })} allowClear /><Select style={{ width: 150 }} placeholder="全部结果" aria-label="操作结果" value={filter.result} allowClear onChange={result => setFilter({ ...filter, result, page: 1 })} options={[{ label: '成功', value: 'SUCCESS' }, { label: '失败', value: 'FAILURE' }]} /></Space>
    {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} pagination={{ current: filter.page, pageSize: 20, total: query.data?.total ?? 0, onChange: page => setFilter({ ...filter, page }) }} columns={[
      { title: '时间', dataIndex: 'createdAt' }, { title: '操作者', dataIndex: 'actor', ellipsis: true }, { title: '操作', dataIndex: 'module' }, { title: '结果', render: (_, row) => row.result === 'SUCCESS' ? '成功' : '失败' }, { title: '原因 / 请求标识', dataIndex: 'content', ellipsis: true },
    ]} />
  </section>
}
