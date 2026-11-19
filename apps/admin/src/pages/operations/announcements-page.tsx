import { useEffect, useState } from 'react'
import { Alert, Button, DatePicker, Form, Input, Message, Modal, Radio, Pagination, Switch, Tag } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { ResourceSelect } from '../../components/resource-select'
import { AnnouncementBody } from '../../components/announcement-body'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { Announcement, AnnouncementInput } from '../../types/operations'
import { useLocation } from 'react-router-dom'
import { CommunityGroupPage, CommunityGroupPreview } from './community-group-page'

export function AnnouncementsPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Announcement>()
  const [generation, setGeneration] = useState(0)
  const { hash } = useLocation()
  useEffect(() => { if (hash === '#community-group') document.getElementById('community-group')?.scrollIntoView() }, [hash])
  const query = useQuery({ queryKey: ['announcements', page], queryFn: () => gateway.listAnnouncements({ page }) })
  const labels = { DRAFT: '草稿', PUBLISHED: '已发布', SCHEDULED: '定时发布' }
  const refresh = () => client.invalidateQueries({ queryKey: ['announcements'] })
  function remove(row: Announcement) {
    Modal.confirm({ title: '删除公告？', content: '该公告将从用户端移除。', okText: '删除', cancelText: '取消', onOk: async () => {
      try {
        await gateway.deleteAnnouncement(row.id, row.version)
        if (query.data?.items.length === 1 && page > 1) setPage(page - 1)
        await refresh()
      } catch (error) { Message.error((error as Error).message); throw error }
    } })
  }
  return <div className="op-broadcast">
    <section className="op-sheet"><h2>新建公告</h2>
      <AnnouncementEditor key={generation} onSaved={() => { setGeneration(x => x + 1); setPage(1); void refresh() }} />
    </section>
    <aside id="community-group" className="op-sheet"><h2>交流群二维码</h2><CommunityGroupPage /></aside>
    <section className="op-sheet op-history"><h2>公告记录 {query.data && <small>{query.data.total}</small>}</h2>
      {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
      {query.isPending && <p role="status">正在读取公告…</p>}
      {query.data?.items.length === 0 && <p className="op-muted">暂无公告记录</p>}
      {query.data?.items.map(row => <article className="op-letter" key={row.id}>
        {editing?.id === row.id ? <AnnouncementEditor record={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void refresh() }} /> : <>
          <div className="op-meta">{row.pinned && <Tag color="blue">置顶</Tag>}<Tag>{labels[row.status]}</Tag>
            <span>{row.audience === 'ALL' ? '全部学生' : '指定学生'}</span>
            {row.publishAt && <time>{new Date(row.publishAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time>}</div>
          <h3>{row.title}</h3>{row.summary && <p>{row.summary}</p>}<AnnouncementBody text={row.body} />
          {row.showCommunityGroup && <CommunityGroupPreview />}
          <div className="op-actions"><Button size="small" onClick={() => setEditing(row)}>编辑</Button>
            <Button type="text" status="danger" size="small" onClick={() => remove(row)}>删除</Button></div>
        </>}
      </article>)}
      {query.data && query.data.total > 20 && <Pagination current={page} total={query.data.total} pageSize={20} onChange={setPage} />}
    </section>
  </div>
}

function AnnouncementEditor({ record, onClose, onSaved }: { record?: Announcement; onClose?: () => void; onSaved: () => void }) {
  const gateway = useAdminGateway(), [form] = Form.useForm<AnnouncementInput>()
  const [audience, setAudience] = useState(record?.audience ?? 'ALL'), [status, setStatus] = useState(record?.status ?? 'DRAFT')
  const save = useMutation({ mutationFn: (input: AnnouncementInput) => gateway.saveAnnouncement(record?.id, { ...input, audience, status, userIds: audience === 'ALL' ? [] : input.userIds, publishAt: input.publishAt ? new Date(input.publishAt).toISOString() : undefined, expectedVersion: record?.version }), onSuccess: () => { Message.success('公告已保存'); onSaved() } })
  return <>
    {save.error && <Alert type="error" content={save.error.message} />}<Form id={record ? `announcement-${record.id}` : 'announcement-new'} className="op-compose" form={form} layout="vertical" disabled={save.isPending} initialValues={record ?? { title: '', summary: '', body: '', audience: 'ALL', userIds: [], status: 'DRAFT' }} onSubmit={values => save.mutate(values)}>
      <div className="op-headfields"><Form.Item field="title" label="标题" rules={[{ required: true }]}><Input maxLength={80} /></Form.Item><Form.Item field="summary" label="摘要"><Input.TextArea maxLength={500} autoSize={{ minRows: 1, maxRows: 3 }} /></Form.Item></div>
      <Form.Item field="body" label="正文（Markdown）"><Input.TextArea maxLength={40000} autoSize={{ minRows: 5 }} /></Form.Item>
      <div className="op-switches"><Form.Item field="pinned" label="置顶公告" triggerPropName="checked"><Switch /></Form.Item>
      <Form.Item field="showCommunityGroup" label="展示交流群二维码" triggerPropName="checked"><Switch /></Form.Item></div>
      <Form.Item label="发布范围"><Radio.Group value={audience} onChange={setAudience}><Radio value="ALL">全部学生</Radio><Radio value="SELECTED">指定学生</Radio></Radio.Group></Form.Item>
      {audience === 'SELECTED' && <Form.Item field="userIds" label="指定学生"><ResourceSelect kind="user" multiple placeholder="搜索并选择学生" /></Form.Item>}
      <Form.Item label="发布状态"><Radio.Group value={status} onChange={setStatus}><Radio value="DRAFT">草稿</Radio><Radio value="PUBLISHED">立即发布</Radio><Radio value="SCHEDULED">定时发布</Radio></Radio.Group></Form.Item>
      {status === 'SCHEDULED' && <Form.Item field="publishAt" label="发布时间" rules={[{ required: true }]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item>}
      <div className="op-actions"><Button type="primary" htmlType="submit" loading={save.isPending}>保存公告</Button>
        {onClose && <Button disabled={save.isPending} onClick={onClose}>取消编辑</Button>}</div>
    </Form>
  </>
}
