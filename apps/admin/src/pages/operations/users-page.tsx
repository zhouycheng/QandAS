import { useState } from 'react'
import { Button, Input, Message, Modal, Select, Space, Table } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { ResourceSelect } from '../../components/resource-select'
import { UserDetailDrawer } from '../../components/user-detail-drawer'
import { useAdminGateway } from '../../gateways/gateway-context'
import { ApiError } from '../../gateways/api-error'
import { GRADE_OPTIONS, gradeLabel } from '../../types/admin'
import type { ManagedUser, UserQuery } from '../../types/operations'

export function UsersPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [filter, setFilter] = useState<UserQuery>({ page: 1 }), [id, setId] = useState<string>()
  const query = useQuery({ queryKey: ['users', filter], queryFn: () => gateway.listUsers(filter) })
  const save = useMutation({ mutationFn: (row: ManagedUser) => gateway.setUserStatus(row.id, row.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED', row.version), onSuccess: () => { void client.invalidateQueries({ queryKey: ['users'] }); Message.success('账号状态已更新') }, onError: error => Message.error(error.message) })
  const update = (patch: UserQuery) => setFilter({ ...filter, ...patch, page: 1 })
  return <section className="list-page" aria-label="用户管理"><Space className="list-toolbar" wrap>
    <Input.Search aria-label="搜索用户" placeholder="昵称、账号或邮箱" value={filter.keyword} onChange={keyword => update({ keyword })} allowClear />
    <ResourceSelect kind="college" placeholder="全部学院" value={filter.collegeId} onChange={value => update({ collegeId: String(value || '') || undefined, majorId: undefined })} />
    <ResourceSelect kind="major" placeholder="全部专业" collegeId={filter.collegeId} value={filter.majorId} onChange={value => update({ majorId: String(value || '') || undefined })} />
    <Select aria-label="年级" style={{ width: 130 }} placeholder="全部年级" options={GRADE_OPTIONS} value={filter.grade} onChange={grade => update({ grade })} allowClear />
    <Select aria-label="账号状态" style={{ width: 140 }} placeholder="全部状态" value={filter.status} options={[{ label: '正常', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }, { label: '待激活', value: 'PENDING' }]} onChange={status => update({ status })} allowClear />
  </Space>{query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<ManagedUser> rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} scroll={{ x: 900 }} pagination={{ current: filter.page, pageSize: 20, total: query.data?.total ?? 0, onChange: page => setFilter({ ...filter, page }), showTotal: true }} columns={[
      { title: '昵称', render: (_, row) => <Button type="text" onClick={() => setId(row.id)}>{row.name}{row.isTestAccount ? '（测试）' : ''}</Button> }, { title: '账号', dataIndex: 'account' }, { title: '学院', dataIndex: 'collegeName' }, { title: '专业', dataIndex: 'majorName' }, { title: '年级', render: (_, row) => gradeLabel(row.grade) }, { title: '状态', render: (_, row) => row.status === 'ACTIVE' ? '正常' : row.status === 'DISABLED' ? '停用' : '待激活' },
      { title: '操作', render: (_, row) => <Button type="text" status="warning" disabled={save.isPending || row.status === 'PENDING' || (row.isTestAccount && row.status === 'DISABLED')} onClick={() => Modal.confirm({ title: row.status === 'DISABLED' ? '恢复账号？' : '停用账号？', content: '停用后将退出该账号的所有登录，学习记录保留。', okText: '确认', cancelText: '取消', onOk: async () => {
        try { await save.mutateAsync(row) }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error
          await client.invalidateQueries({ queryKey: ['users'] })
        }
      } })}>{row.status === 'DISABLED' ? '恢复' : '停用'}</Button> },
    ]} />{id && <UserDetailDrawer id={id} onClose={() => setId(undefined)} />}
  </section>
}
