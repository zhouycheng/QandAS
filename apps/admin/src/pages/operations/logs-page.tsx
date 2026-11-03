import { useState } from 'react'
import { Input, Select, Space, Table } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { LogQuery } from '../../types/operations'
import { formatDate } from '../../lib/format'

const reasonLabels: Record<string, string> = { INTERNAL_ERROR: '服务处理失败', NOT_FOUND: '记录不存在', UNAUTHENTICATED: '登录验证失败', FORBIDDEN: '没有操作权限', VERSION_CONFLICT: '内容已更新', RELATION_CONFLICT: '记录有关联数据', VALIDATION_FAILED: '填写内容有误' }
const logReason = (content: string) => content.replace(/^[A-Z_]+/, code => reasonLabels[code] ?? code)

export function LogsPage() {
  const gateway = useAdminGateway(), [filter, setFilter] = useState<LogQuery>({ page: 1 })
  const query = useQuery({ queryKey: ['logs', filter], queryFn: () => gateway.listOperationLogs(filter) })
  return <section className="list-page" aria-label="操作日志"><Space className="list-toolbar" wrap><Input.Search aria-label="搜索日志" placeholder="操作、原因或请求 ID" value={filter.keyword} onChange={keyword => setFilter({ ...filter, keyword, page: 1 })} allowClear /><Select style={{ width: 150 }} placeholder="全部结果" aria-label="操作结果" value={filter.result} allowClear onChange={result => setFilter({ ...filter, result, page: 1 })} options={[{ label: '成功', value: 'SUCCESS' }, { label: '失败', value: 'FAILURE' }]} /></Space>
    {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table scroll={{ x: 760 }} rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} pagination={{ current: filter.page, pageSize: 20, total: query.data?.total ?? 0, onChange: page => setFilter({ ...filter, page }) }} columns={[
      { title: '时间', render: (_, row) => formatDate(row.createdAt) }, { title: '操作者', dataIndex: 'actor', ellipsis: true }, { title: '操作', dataIndex: 'module' }, { title: '结果', render: (_, row) => row.result === 'SUCCESS' ? '成功' : '失败' }, { title: '原因 / 请求标识', render: (_, row) => logReason(row.content), ellipsis: true },
    ]} />
  </section>
}
