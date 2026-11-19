import { useEffect, useState } from 'react'
import { Alert, Button, Empty, Message, Modal, Table, Tag } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import { LineChart } from '../../components/charts'
import type { SyncSnapshot, StreamStatus } from '../../types/monitoring'
import { getErrorMessage } from '../../lib/errors'
import { formatDate } from '../../lib/format'

const number = (value: number | null | undefined, digits = 0) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
const statusLabels = { CONNECTING: '正在连接', LIVE: '实时连接', RECONNECTING: '连接中断，正在重连', AUTH_EXPIRED: '权限已失效' }
const componentLabels: Record<string, string> = { rabbitmq: '消息队列', monitor: '监控服务', worker: '同步服务', api: '业务服务' }
function latestSample(stream?: SyncSnapshot, summary?: SyncSnapshot) {
  if (!stream || !summary) return stream ?? summary
  return Date.parse(summary.checkedAt) > Date.parse(stream.checkedAt) ? summary : stream
}
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
  const summary = health.data?.sync
  const latest = latestSample(snapshot, summary)
  const lastGood = latestSample(history.at(-1), summary?.status === 'HEALTHY' ? summary : undefined)
  const sample = latest?.status === 'HEALTHY' ? latest : lastGood
  const metric = sample?.metrics
  const stale = status !== 'LIVE' || latest?.status !== 'HEALTHY'
  const inspectHead = visible && (stale || (metric?.deadLetters ?? 0) > 0)
  const head = useQuery({ queryKey: ['sync-dead-letter-head'], queryFn: () => gateway.getDeadLetterHead(), enabled: inspectHead, refetchInterval: inspectHead ? 30000 : false })
  const item = inspectHead ? head.data?.item : undefined
  function confirmReplay() {
    if (!item?.commandId || !item.sessionId) return
    const commandId = item.commandId
    Modal.confirm({ title: '恢复答题同步', content: '重新处理练习 ' + item.sessionId + ' 的同步任务 ' + commandId + '？',
      okText: '确认处理', cancelText: '取消', onOk: async () => {
        try { await gateway.replaySyncCommand(commandId); Message.success('处理完成'); await Promise.all([head.refetch(), health.refetch()]) }
        catch (error) { Message.error(getErrorMessage(error)); throw error }
      } })
  }
  const series = (history.length ? history : sample ? [sample] : []).filter(s =>
    s.sampledAt && s.metrics.productionPerSecond != null && s.metrics.consumptionPerSecond != null)
  const services = health.data?.components ?? []
  return <section className="mg-stack monitor-page" aria-label="系统监控">
    <section className="op-sheet">
      <header className="system-section-head"><div className="monitor-status"><h2>答题同步</h2>
        <Tag color={status === 'LIVE' && visible ? 'green' : 'orange'}>{visible ? statusLabels[status] : '已暂停'}</Tag>
        <small>{sample?.sampledAt ? '最近采样 ' + formatDate(sample.sampledAt) : '等待首次采样'}</small></div>
        <Button size="small" onClick={() => { setAttempt(a => a + 1); void health.refetch() }}>重新连接</Button>
      </header>
      {(stale || latest?.reason) && <p className="monitor-note" role="status">{latest?.reason || (sample ? '正在显示最近一次成功采样。' : '正在等待可用的同步数据。')}</p>}
      {health.error && <Alert type="warning" content={health.data ? '系统摘要更新失败，显示最近成功数据' : '系统摘要读取失败'} action={<Button onClick={() => void health.refetch()}>重试</Button>} />}
      {inspectHead && head.error && <Alert type="warning" content="待恢复任务读取失败" action={<Button onClick={() => void head.refetch()}>重试</Button>} />}
      {item && <div className="recovery-task"><div><strong>待恢复任务</strong><p>{item.reason || item.failure?.message || '同步处理失败'}</p>
        <small>任务 {item.commandId || '未知'} · 练习 {item.sessionId || '未知'}</small></div>
        <Button size="small" disabled={!item.commandId || !item.sessionId || head.isError} onClick={confirmReplay}>恢复任务</Button></div>}
      <dl className="monitor-counts">{([['排队',metric?.queued],['处理中',metric?.processing],['等待重试',metric?.retrying],['待恢复',metric?.deadLetters]] as const)
        .map(([name,value]) => <div key={name}><dt>{name}</dt><dd className={name === '待恢复' && value ? 'needs-recovery' : undefined}>{number(value)}</dd></div>)}</dl>
    </section>
    <div className="monitor-grid">
      <section className="op-sheet"><header className="system-section-head"><h2>同步吞吐</h2><small>{latest?.windowSeconds ?? 60} 秒采样窗口</small></header>
        <div className="monitor-rates"><span>接收 <b>{number(metric?.productionPerSecond, 2)}</b> 次/秒</span><span>处理 <b>{number(metric?.consumptionPerSecond, 2)}</b> 次/秒</span><span>保存完成 <b>{number(metric?.committedPerSecond, 2)}</b> 次/秒</span></div>
        <div className="monitor-plot"><LineChart width={620} height={200} showEmptyAxes label="答题进度接收与处理速度，单位次每秒"
          data={series.map(s => ({ label: new Date(s.sampledAt!).toLocaleTimeString('zh-CN', { hour12: false }), value: s.metrics.productionPerSecond!, secondary: s.metrics.consumptionPerSecond! }))} />
          {!series.length && <span>{health.error ? '暂未取得采样' : '等待速率采样'}</span>}</div>
        <p className="monitor-note">接收和处理包含重试，保存完成按任务去重。离线答题在上传后计入。</p>
      </section>
      <section className="op-sheet"><header className="system-section-head"><h2>服务与后台任务</h2>
        {health.data?.sampledAt && <small>{formatDate(health.data.sampledAt)}</small>}</header>
        <dl className="system-facts">{services.map(c => <div key={c.name}><dt>{componentLabels[c.name] ?? c.name}</dt><dd>
          <Tag color={c.status === 'UP' ? 'green' : 'red'}>{c.status === 'UP' ? '正常' : c.status === 'DOWN' ? '中断' : c.status}</Tag></dd></div>)}
          {([['同步处理通道',metric?.consumers,'个'],['活跃统计待处理',health.data?.activityPending,'条'],['邮件待处理',health.data?.mailPending,'条'],
            ['平均同步延迟',metric?.averageLatencyMs,'毫秒'],['P95 保存耗时',metric?.p95LatencyMs,'毫秒']] as const).map(([name,value,unit]) =>
            <div key={name}><dt>{name}</dt><dd>{number(value,1)} <small>{unit}</small></dd></div>)}</dl>
      </section>
    </div>
    <section className="op-sheet list-page"><h2>接口健康</h2>
      <Table scroll={{ x: 650 }} rowKey={row => row.method + row.path} data={health.data?.endpoints ?? []} noDataElement={<Empty description={health.error ? '接口健康数据读取失败' : '暂无接口采样'} />} pagination={{ pageSize: 20 }} columns={[
        { title: '请求接口', render: (_, row) => <div className="endpoint-path"><code>{row.method}</code><span>{row.path}</span></div> },
        { title: '请求/秒', width: '15%', align: 'right', render: (_, row) => number(row.requestsPerSecond, 2) },
        { title: '服务错误/秒', width: '18%', align: 'right', render: (_, row) => number(row.errorsPerSecond, 2) },
        { title: 'P95 耗时（秒）', width: '20%', align: 'right', render: (_, row) => number(row.p95Seconds, 3) },
      ]} />
    </section>
  </section>
}
