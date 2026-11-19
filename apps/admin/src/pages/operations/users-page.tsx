import { ExcelTransfer } from '../../components/excel-transfer'
import { useState } from 'react'
import { Button, Empty, Input, Message, Modal, Select, Table, Tag } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { UserDetailDrawer } from '../../components/user-detail-drawer'
import { useAdminGateway } from '../../gateways/gateway-context'
import { ApiError } from '../../gateways/api-error'
import type { ManagedUser, UserQuery } from '../../types/operations'

export function UsersPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [filter, setFilter] = useState<UserQuery>({ page: 1 }), [id, setId] = useState<string>()
  const query = useQuery({ queryKey: ['users', filter], queryFn: () => gateway.listUsers(filter) })
  const save = useMutation({ mutationFn: (row: ManagedUser) => gateway.setUserStatus(row.id, row.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED', row.version), onSuccess: () => { void client.invalidateQueries({ queryKey: ['users'] }); Message.success('账号状态已更新') }, onError: error => Message.error(error.message) })
  const update = (patch: UserQuery) => setFilter({ ...filter, ...patch, page: 1 })
  return <section className="list-page op-sheet mg-list" aria-label="用户管理"><div className="mg-tools">
    <Input.Search aria-label="搜索用户" placeholder="昵称、账号或邮箱" value={filter.keyword} onChange={keyword => update({ keyword })} allowClear />
    <Select aria-label="账号状态" style={{ width: 140 }} placeholder="全部状态" value={filter.status} options={[{ label: '正常', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }, { label: '待激活', value: 'PENDING' }]} onChange={status => update({ status })} allowClear />
  <ExcelTransfer resource="users" query={filter} count={query.data?.total} scopeLabel={[filter.keyword && '搜索「' + filter.keyword + '」', filter.status && ({ACTIVE:'正常', DISABLED:'停用', PENDING:'待激活'} as const)[filter.status]].filter(Boolean).join('，') || '全部用户'} onImported={() => void client.invalidateQueries({ queryKey: ['users'] })} /></div>{query.error && <ErrorState stale={!!query.data} message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<ManagedUser> rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} noDataElement={<Empty description={query.error ? '用户列表加载失败' : filter.keyword || filter.status ? '没有符合条件的用户' : '暂无用户'} />} pagination={{ current: filter.page, pageSize: 20, total: query.data?.total ?? 0, onChange: page => setFilter({ ...filter, page }), showTotal: true }} columns={[
      { title: '昵称', render: (_, row) => <Button type="text" onClick={() => setId(row.id)}>{row.name}</Button> }, { title: '账号', render: (_, row) => <span>{row.account} {row.isTestAccount && <Tag>测试</Tag>}</span> }, { title: '状态', render: (_, row) => <Tag color={row.status === 'ACTIVE' ? 'green' : row.status === 'DISABLED' ? 'gray' : 'orange'}>{row.status === 'ACTIVE' ? '正常' : row.status === 'DISABLED' ? '停用' : '待激活'}</Tag> },
      { title: '操作', render: (_, row) => <Button type="text" status="warning" disabled={save.isPending || row.status === 'PENDING' || (row.isTestAccount && row.status === 'DISABLED')} onClick={() => Modal.confirm({ title: row.status === 'DISABLED' ? '恢复账号？' : '停用账号？', content: row.status === 'DISABLED' ? row.name + ' 将可以重新登录，继续使用原有学习记录。' : row.name + ' 的所有登录将退出，学习记录保留。', okText: '确认', cancelText: '取消', onOk: async () => {
        try { await save.mutateAsync(row) }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error
          await client.invalidateQueries({ queryKey: ['users'] })
        }
      } })}>{row.status === 'DISABLED' ? '恢复' : '停用'}</Button> },
    ]} />{id && <UserDetailDrawer id={id} onClose={() => setId(undefined)} />}
  </section>
}
