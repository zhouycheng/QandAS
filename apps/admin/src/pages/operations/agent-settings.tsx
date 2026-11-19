import { Alert, Button, Empty, Modal, Space, Typography } from '@arco-design/web-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import { formatDate } from '../../lib/format'

const labels: Record<string, string> = { 'banks:read': '读取和导出题库', 'banks:write': '编辑草稿、导入题目', 'banks:publish': '发布、下架、归档和编辑线上题库',
  'catalog:read': '读取院系与课程',
  'catalog:write': '维护院系与课程',
  'users:read': '读取用户',
  'users:write': '维护用户',
  'test_accounts:read': '读取测试账号',
  'test_accounts:write': '维护测试账号',
  'admins:read': '读取管理员',
  'announcements:read': '读取公告',
  'announcements:write': '维护公告',
  'feedback:read': '读取反馈与缺课需求',
  'feedback:write': '维护反馈与缺课需求',
  'operations:read': '读取运营统计',
  'security:read': '读取安全设置',
  'security:write': '维护安全设置',
  'audit:read': '读取审计日志',
}
export function AgentSettings({ consent = false }: { consent?: boolean }) {
  const gateway = useAdminGateway()
  const list = useQuery({ queryKey: ['bank-agents'], queryFn: () => gateway.bankAgents() })
  const revoke = useMutation({ mutationFn: (id: string) => gateway.revokeAgent(id), onSuccess: () => list.refetch() })
  const params = new URLSearchParams(location.search)
  const value = (key: string) => params.get(key) || ''
  const scope = value('scope') || 'banks:read'
  const authorize = useMutation({ mutationFn: async () => {
    const redirect = new URL(value('redirect_uri'))
    const { code } = await gateway.authorizeAgent({ clientId: value('client_id'), redirectUri: value('redirect_uri'), resource: value('resource'), scope,
      challenge: value('code_challenge'), method: value('code_challenge_method') })
    redirect.searchParams.set('code', code)
    if (params.has('state')) redirect.searchParams.set('state', value('state'))
    location.assign(redirect.href)
  } })
  const error = list.error || revoke.error || authorize.error
  const invalid = !list.data?.resource || list.data.resource !== value('resource') || value('response_type') !== 'code' ||
    !value('client_id') || !value('redirect_uri') || scope.split(' ').some(s => !labels[s])
  return <section className={consent ? 'op-sheet agent-panel agent-consent' : 'op-sheet agent-panel'}>
    <h2>{consent ? '授权请求' : 'Agent 接入'}</h2>
    {error && <Alert type="error" content={error.message} action={list.error && <Button onClick={() => void list.refetch()}>重试</Button>} />}
    {consent ? <>
      <dl className="agent-client"><dt>客户端</dt><dd>{value('client_id')}</dd><dt>回调地址</dt><dd><code>{value('redirect_uri')}</code></dd></dl>
      <h3>申请权限</h3><ul className="agent-scopes">{scope.split(' ').map(s => <li key={s}>{labels[s] || s}</li>)}</ul>
      {invalid && list.data && <Alert type="error" content="授权请求的资源、客户端或权限无效" />}
      <Space><Button type="primary" disabled={invalid} loading={authorize.isPending} onClick={() => authorize.mutate()}>同意授权</Button>
        <Button href="/security">取消</Button></Space>
    </> : <>
      {list.isPending && <p role="status">正在读取授权记录…</p>}
      {list.data && <><div className="agent-endpoint"><h3>MCP 地址</h3>{list.data.resource
        ? <Typography.Text className="system-code" copyable={{ text: list.data.resource }}>{list.data.resource}</Typography.Text>
        : <span className="muted">尚未配置</span>}</div>
        <h3>已授权客户端 <small>{list.data.agents.length}</small></h3>
        {list.data.agents.length === 0 && <Empty description="暂无已授权客户端" />}
        {list.data.agents.map(agent => <article className="agent-row" key={agent.id}>
          <header><strong>{agent.client}</strong><Button type="text" status="danger" disabled={revoke.isPending} onClick={() => Modal.confirm({
            title: '撤销授权？', content: '「' + agent.client + '」将失去这项授权。', okText: '撤销授权', cancelText: '取消', onOk: () => revoke.mutateAsync(agent.id),
          })}>撤销授权</Button></header>
          {agent.expires_at && <small className="muted">到期时间 {formatDate(agent.expires_at)}</small>}
          <ul className="agent-scopes" aria-label={agent.client + '的权限'}>{agent.scope.split(/\s+/).filter(Boolean).map(s => <li key={s}>{labels[s] ?? s}</li>)}</ul>
        </article>)}</>}
    </>}
  </section>
}
