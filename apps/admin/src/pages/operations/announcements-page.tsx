import { useState } from 'react'
import { Alert, Button, DatePicker, Drawer, Form, Input, Message, Modal, Radio, Space, Switch, Table, Tag } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { ResourceSelect } from '../../components/resource-select'
import { AnnouncementBody } from '../../components/announcement-body'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { Announcement, AnnouncementInput } from '../../types/operations'
import { CommunityGroupPreview } from './community-group-page'

export function AnnouncementsPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [page, setPage] = useState(1), [editing, setEditing] = useState<Announcement | null>(), [preview, setPreview] = useState<Announcement>()
  const query = useQuery({ queryKey: ['announcements', page], queryFn: () => gateway.listAnnouncements({ page }) })
  const labels = { DRAFT: '草稿', PUBLISHED: '已发布', SCHEDULED: '定时发布' }
  return <section aria-label="公告管理"><Button type="primary" onClick={() => setEditing(null)}>新建公告</Button>{query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<Announcement> rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: setPage }} columns={[
      { title: '标题', render: (_, row) => <Space>{row.pinned && <Tag color="blue">置顶</Tag>}{row.title}</Space> }, { title: '状态', render: (_, row) => labels[row.status] }, { title: '发布时间', dataIndex: 'publishAt' },
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
    {save.error && <Alert type="error" content={save.error.message} />}<Form form={form} layout="vertical" disabled={save.isPending} initialValues={record ?? { title: '', summary: '', body: '', audience: 'ALL', userIds: [], status: 'DRAFT' }} onSubmit={values => save.mutate(values)}>
      <Form.Item field="title" label="标题" rules={[{ required: true }]}><Input maxLength={80} /></Form.Item><Form.Item field="summary" label="摘要"><Input.TextArea maxLength={500} /></Form.Item>
      <Form.Item field="body" label="Markdown 正文" extra="支持代码块、表格和换行。发布前可在公告列表完整预览。"><Input.TextArea maxLength={40000} autoSize={{ minRows: 8 }} /></Form.Item>
      <Form.Item field="pinned" label="置顶公告" triggerPropName="checked"><Switch /></Form.Item>
      <Form.Item field="showCommunityGroup" label="展示交流群二维码" triggerPropName="checked" extra="使用“用户交流群”中维护的当前群码。"><Switch /></Form.Item>
      <Form.Item label="发布范围"><Radio.Group value={audience} onChange={setAudience}><Radio value="ALL">全部学生</Radio><Radio value="SELECTED">指定学生</Radio></Radio.Group></Form.Item>
      {audience === 'SELECTED' && <Form.Item field="userIds" label="指定学生"><ResourceSelect kind="user" multiple placeholder="搜索并选择学生" /></Form.Item>}
      <Form.Item label="发布状态"><Radio.Group value={status} onChange={setStatus}><Radio value="DRAFT">草稿</Radio><Radio value="PUBLISHED">立即发布</Radio><Radio value="SCHEDULED">定时发布</Radio></Radio.Group></Form.Item>
      {status === 'SCHEDULED' && <Form.Item field="publishAt" label="发布时间" rules={[{ required: true }]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item>}
    </Form>
  </Drawer>
}
