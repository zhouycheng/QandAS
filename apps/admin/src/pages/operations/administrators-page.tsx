import { useState } from 'react'
import { Alert, Button, Empty, Form, Input, Message, Radio, Table, Tag } from '@arco-design/web-react'
import { IconPlus } from '@arco-design/web-react/icon'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { ManagementDrawer } from '../../components/management-drawer'
import { useAdminGateway } from '../../gateways/gateway-context'
import { getAdminSession } from '../../lib/auth'
import { formatDate } from '../../lib/format'
import { closeDraft, formHasChanges } from '../../lib/unsaved-changes'
import type { AdminAccount, AdminAccountInput } from '../../types/operations'

export function AdministratorsPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<AdminAccount | null>()
  const query = useQuery({ queryKey: ['administrators', page], queryFn: () => gateway.listAdminAccounts({ page }) })
  const session = getAdminSession()
  return <section className="op-sheet list-page mg-list" aria-label="管理员账号">
    <header className="system-section-head"><h2>账号列表{query.data && <small>{query.data.total} 位</small>}</h2>
      <Button type="primary" icon={<IconPlus />} onClick={() => setEditing(null)}>新增管理员</Button>
    </header>
    {query.error && <ErrorState stale={!!query.data} message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<AdminAccount> rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} scroll={{ x: 580 }}
      noDataElement={<Empty description={query.error ? '管理员列表加载失败' : '暂无管理员'} />}
      pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: setPage }} columns={[
        { title: '姓名 / 登录账号', render: (_, row) => <button className="admin-account-name" onClick={() => setEditing(row)}>
          <strong>{row.name}</strong><small>{row.username}{row.id === session?.id && ' · 当前账号'}</small></button> },
        { title: '最近登录', width: '24%', render: (_, row) => row.lastLoginAt ? formatDate(row.lastLoginAt) : '尚未登录' },
        { title: '创建时间', width: '24%', render: (_, row) => formatDate(row.createdAt) },
        { title: '账号状态', width: 100, render: (_, row) => <Tag color={row.status === 'ACTIVE' ? 'green' : 'gray'}>{row.status === 'ACTIVE' ? '已启用' : '已停用'}</Tag> },
      ]} />
    {editing !== undefined && <AdminEditor record={editing ?? undefined} onClose={() => setEditing(undefined)} onSaved={() => {
      void client.invalidateQueries({ queryKey: ['administrators'] })
      void client.invalidateQueries({ queryKey: ['resource-select'] })
      Message.success('管理员账号已保存')
    }} />}
  </section>
}

function AdminEditor({ record, onClose, onSaved }: { record?: AdminAccount; onClose: () => void; onSaved: () => void }) {
  const gateway = useAdminGateway()
  const [form] = Form.useForm<AdminAccountInput>()
  const initial = { name: record?.name ?? '', username: record?.username ?? '', password: '', status: record?.status ?? 'ACTIVE' }
  const save = useMutation({ mutationFn: (input: AdminAccountInput) => gateway.saveAdminAccount(record?.id, { ...input, password: input.password || undefined, expectedVersion: record?.version }), onSuccess: onSaved, onError: error => Message.error(error.message) })
  return <ManagementDrawer visible width={520} style={{ maxWidth: '100vw' }} title={record ? '编辑管理员' : '新增管理员'}
    onCancel={() => closeDraft(!save.isPending && formHasChanges(initial, form.getFieldsValue()), onClose)} confirmLoading={save.isPending}
    onOk={() => form.submit()} okText="保存" cancelText="取消">
    <Form form={form} layout="vertical" disabled={save.isPending} initialValues={initial} onSubmit={values => { if (!save.isPending) save.mutate(values, { onSuccess: onClose }) }}>
      <Form.Item field="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}><Input maxLength={40} /></Form.Item>
      <Form.Item field="username" label="登录账号" rules={[{ required: true, message: '请输入登录账号' }]}><Input maxLength={64} /></Form.Item>
      <Form.Item field="password" label={record ? '新密码' : '初始密码'} extra={record && '留空将保留原密码。'} rules={[{ required: !record, message: '请输入初始密码' }]}><Input.Password autoComplete="new-password" /></Form.Item>
      <Form.Item field="status" label="账号状态"><Radio.Group><Radio value="ACTIVE">启用</Radio><Radio value="DISABLED">停用</Radio></Radio.Group></Form.Item>
      <p className="muted">管理员可管理系统和其他管理员账号。</p>
      {save.error && <Alert type="error" content={save.error.message} />}
    </Form>
  </ManagementDrawer>
}
