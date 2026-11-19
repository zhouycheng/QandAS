import { useState } from 'react'
import { Empty, Input, Table, Tag, Typography } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import { getAdminSession } from '../../lib/auth'
import { formatDate } from '../../lib/format'
import type { LogQuery } from '../../types/operations'

const reasons: Record<string, string> = { INTERNAL_ERROR: '服务处理失败', NOT_FOUND: '记录不存在', UNAUTHENTICATED: '登录验证失败', FORBIDDEN: '没有操作权限', VERSION_CONFLICT: '内容已更新', RELATION_CONFLICT: '记录有关联数据', VALIDATION_FAILED: '填写内容有误' }
const operations: Record<string, string> = {
  CREATE_ADMIN: '新增管理员', UPDATE_ADMIN: '编辑管理员', SECURITY_POLICY: '修改安全规则',
  CREATE_BANK: '新建题库', UPDATE_BANK: '修改题库', PUBLISH_BANK: '变更题库发布状态', IMPORT_PACKAGE: '导入题包',
  CREATE_SUBJECT: '新建课程', UPDATE_SUBJECT: '编辑课程', CREATE_QUESTION: '新建题目', UPDATE_QUESTION: '编辑题目',
  CREATE_CHAPTER: '新建章节', UPDATE_CHAPTER: '编辑章节', UPDATE_USER_PROFILE: '修改学生资料', USER_STATUS: '变更账号状态',
  REORDER_CHAPTERS: '调整章节顺序', DELETE_CHAPTER: '删除章节', CREATE_COLLEGE: '新增学院', UPDATE_COLLEGE: '编辑学院',
  CREATE_MAJOR: '新增专业', UPDATE_MAJOR: '编辑专业', CREATE_TEST_ACCOUNT: '新建测试账号', DISABLE_TEST_ACCOUNT: '停用测试账号',
  VIEW_TEST_ACCOUNT_CREDENTIALS: '查看测试账号凭据', REPLAY_SYNC: '恢复同步任务', CREATE_ANNOUNCEMENT: '新建公告',
  UPDATE_ANNOUNCEMENT: '编辑公告', DELETE_ANNOUNCEMENT: '删除公告', HANDLE_FEEDBACK: '处理学生反馈',
}
export function LogsPage() {
  const gateway = useAdminGateway()
  const session = getAdminSession()
  const [filter, setFilter] = useState<LogQuery>({ page: 1 })
  const query = useQuery({ queryKey: ['logs', filter], queryFn: () => gateway.listOperationLogs(filter) })
  return <section className="op-sheet list-page mg-list log-list" aria-label="操作日志">
    <div className="system-section-head">
      <div className="bw-status-filters" role="group" aria-label="操作结果">
        {([['', '全部结果'], ['FAILURE', '失败'], ['SUCCESS', '成功']] as const).map(([result, label]) => {
          const selected = (filter.result ?? '') === result
          return <button key={label} className={selected ? 'active' : ''} aria-pressed={selected}
            onClick={() => setFilter({ ...filter, result: result || undefined, page: 1 })}>{label}</button>
        })}
      </div>
      <Input.Search className="audit-search" aria-label="搜索日志" placeholder="操作代码、原因代码或请求 ID"
        value={filter.keyword} allowClear onChange={keyword => setFilter({ ...filter, keyword, page: 1 })} />
    </div>
    {query.error && <ErrorState stale={!!query.data} message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table rowKey="id" data={query.data?.items ?? []} loading={query.isFetching}
      noDataElement={<Empty description={query.error ? '日志加载失败' : filter.keyword || filter.result ? '没有符合条件的日志' : '暂无操作日志'} />}
      pagination={{ current: filter.page, pageSize: 20, total: query.data?.total ?? 0, onChange: page => setFilter({ ...filter, page }) }} columns={[
        { title: '操作记录', render: (_, row) => {
          const [code, ...target] = row.module.split(':')
          return <div className="mg-entity" title={row.module}><strong>{operations[code] ?? code}</strong>{target.length > 0 && <code className="system-code">{target.join(':')}</code>}</div>
        } },
        { title: '处理结果', width: '16%', render: (_, row) => <div className="mg-entity">
          <Tag color={row.result === 'SUCCESS' ? 'green' : 'red'}>{row.result === 'SUCCESS' ? '成功' : '失败'}</Tag>
          {row.reasonCode && <small title={row.reasonCode}>{reasons[row.reasonCode] ?? row.reasonCode}</small>}
        </div> },
        { title: '操作者 / 时间', width: '23%', render: (_, row) => <div className="mg-entity"><span title={row.actor}>{session?.id === row.actor ? session.name || session.username : row.actor}</span><small>{formatDate(row.createdAt)}</small></div> },
        { title: '请求 ID', width: '30%', render: (_, row) => row.requestId
          ? <Typography.Text className="system-code" copyable={{ text: row.requestId }}>{row.requestId}</Typography.Text> : '—' },
      ]} />
  </section>
}
