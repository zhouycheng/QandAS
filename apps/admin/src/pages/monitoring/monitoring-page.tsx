import { useEffect, useState } from 'react'
import { Alert, Button, Card, Space, Table, Tag, Modal, Message } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import { LineChart } from '../../components/charts'
import type { SyncSnapshot, StreamStatus } from '../../types/monitoring'
import { getErrorMessage } from '../../lib/errors'

const number = (value: number | null | undefined, digits = 0) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
const statusLabels = { CONNECTING: '正在连接', LIVE: '实时连接', RECONNECTING: '连接中断，正在重连', AUTH_EXPIRED: '权限已失效' }
export function MonitoringPage() {
  const gateway = useAdminGateway()
  const [visible, setVisible] = useState(!document.hidden), [attempt, setAttempt] = useState(0)
  const [snapshot, setSnapshot] = useState<SyncSnapshot>(), [status, setStatus] = useState<StreamStatus>('CONNECTING')
  const [history, setHistory] = useState<SyncSnapshot[]>([])
  useEffect(() => { const change = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change) }, [])
  useEffect(() => {
    if (!visible) return
    return gateway.watchSyncHealth(value => {
      setSnapshot(value)
      if (value.status === 'HEALTHY') setHistory(old => old.at(-1)?.sampledAt === value.sampledAt ? old : [...old.slice(-59), value])
    }, setStatus)
  }, [gateway, visible, attempt])
  const health = useQuery({ queryKey: ['system-health'], queryFn: () => gateway.getSystemHealth(), enabled: visible, refetchInterval: visible ? 30000 : false, refetchIntervalInBackground: false })
  const metric = snapshot?.metrics, stale = status !== 'LIVE' || ['STALE', 'UNAVAILABLE'].includes(snapshot?.status ?? 'UNAVAILABLE')
  const [reviewing, setReviewing] = useState(false)
  async function reviewDeadLetter() {
    setReviewing(true)
    try {
      const { item } = await gateway.getDeadLetterHead()
      if (!item) { Message.info('当前没有待处理死信'); return }
      Modal.confirm({ title: '重新处理同步命令', content: <div><p>命令：{item.commandId ?? '无法识别'}</p><p>练习：{item.sessionId ?? '无法识别'}</p><p>{item.reason ?? item.failure?.message}</p>{!item.reason && <p>确认故障已恢复后，使用原命令重新入队。</p>}</div>, okText: '确认处理', okButtonProps: { disabled: !item.commandId || !item.sessionId }, onOk: async () => {
        try { await gateway.replaySyncCommand(item.commandId!); Message.success('处理完成'); void health.refetch() }
        catch (error) { Message.error(getErrorMessage(error)); throw error }
      } })
    } catch (error) { Message.error(getErrorMessage(error)) }
    finally { setReviewing(false) }
  }
  return <section aria-label="系统监控">
    <Space className="section-gap" wrap><Tag color={stale ? 'orange' : 'green'}>{visible ? statusLabels[status] : '已暂停'}</Tag><span className="muted">采样：{snapshot?.sampledAt ? new Date(snapshot.sampledAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '等待数据'} · 速率窗口 {snapshot?.windowSeconds ?? 60} 秒</span><Button onClick={() => { setAttempt(a => a + 1); void health.refetch() }}>重新连接</Button></Space>
    {(stale || snapshot?.reason) && <Alert type="warning" content={stale ? '数据已过期，显示最近成功采样；连接恢复后自动更新。' : snapshot?.reason} />}
    <div className="compact-metrics sync-metrics">
      {[
        ['当前排队', number(metric?.queued), '条等待处理'], ['正在处理', number(metric?.processing), '条待确认'],
        ['平均生产速率', number(metric?.productionPerSecond, 2), '条/秒'], ['平均消费速率', number(metric?.consumptionPerSecond, 2), '条/秒'],
        ['成功落库速率', number(metric?.committedPerSecond, 2), '唯一命令/秒'], ['等待重试 / 死信', number(metric?.retrying) + ' / ' + number(metric?.deadLetters), '条'],
        ['平均同步延迟', number(metric?.averageLatencyMs, 1), '毫秒'], ['p95 同步延迟', number(metric?.p95LatencyMs, 1), '毫秒'],
      ].map(([label, value, unit]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{unit}</small></div>)}
    </div>
    <Button className="section-gap" loading={reviewing} onClick={() => { void reviewDeadLetter() }}>查看待处理死信</Button>
    <Card title="生产与消费" bordered={false}>
      <LineChart label="答题进度生产与消费速率，单位条每秒" data={history.map(s => ({ label: new Date(s.sampledAt!).toLocaleTimeString('zh-CN', { hour12: false }), value: s.metrics.productionPerSecond ?? 0, secondary: s.metrics.consumptionPerSecond ?? 0 }))} />
      <p className="muted">深蓝为生产，浅蓝为消费。生产与消费包含重投；落库按命令去重。一条命令可以包含多道题，离线草稿在上传后进入队列统计。</p>
    </Card>
    {health.error && <Alert type="warning" content="系统摘要更新失败，显示最近成功数据" action={<Button onClick={() => { void health.refetch() }}>重试</Button>} />}
    <Card title="模块与后台任务" bordered={false} className="section-gap">
      <Space wrap>{health.data?.components.map(c => <Tag key={c.name} color={c.status === 'UP' ? 'green' : 'red'}>{c.name} · {c.status === 'UP' ? '采集正常' : '采集中断'}</Tag>)}</Space>
      <p>同步消费者 {number(metric?.consumers)} 个 · 活跃统计待处理 {number(health.data?.activityPending)} 条 · 邮件待处理 {number(health.data?.mailPending)} 条</p>
      <p className="muted">摘要采样：{health.data?.sampledAt ? new Date(health.data.sampledAt).toLocaleString('zh-CN') : '等待数据'}</p>
      <p className="muted">服务标签表示指标端点的连接状态，业务请求耗时与错误率见下方。</p>
    </Card>
    <Card title="接口健康" bordered={false} className="section-gap">
      <Table rowKey={row => row.method + row.path} data={health.data?.endpoints ?? []} pagination={{ pageSize: 20 }} columns={[
        { title: '方法', dataIndex: 'method', width: 90 }, { title: '接口', dataIndex: 'path' },
        { title: '请求/秒', render: (_, row) => number(row.requestsPerSecond, 2) }, { title: '5xx/秒', render: (_, row) => number(row.errorsPerSecond, 2) },
        { title: 'p95（秒）', render: (_, row) => number(row.p95Seconds, 3) },
      ]} />
    </Card>
  </section>
}
