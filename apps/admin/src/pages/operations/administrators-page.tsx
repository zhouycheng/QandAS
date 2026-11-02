import { useState } from 'react'
import { Alert, Button, Form, Input, Modal, Radio, Table } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { AdminAccount, AdminAccountInput } from '../../types/operations'

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
