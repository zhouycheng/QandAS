import { useState } from 'react'
import { Button, Empty, Table } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import { ErrorState } from '../../components/error-state'
import { getAdminSession } from '../../lib/auth'
import { formatDate } from '../../lib/format'

export default function CompatibilityPage() {
  const gateway = useAdminGateway()
  const [release, select] = useState<string>()
  const query = useQuery({ queryKey: ['compatibility', getAdminSession()?.id, release], queryFn: () => gateway.getCompatibility(release) })
  const data = query.data
  const selected = data?.releases.find(entry => entry.release === data.selected)
  const count = (id: string, period: 'week' | 'month') => {
    if (!data) return '—'
    const start = new Date(data.checkedAt)
    start.setUTCHours(0, 0, 0, 0)
    start.setUTCDate(start.getUTCDate() - (period === 'week' ? 6 : 29))
    const partial = data.gaps.some(gap => Date.parse(gap.end) > start.getTime())
    const value = data.stats.find(row => row.item === id)?.[period] ?? 0
    return partial ? value ? `≥ ${value}` : '未知' : String(value)
  }
  return <section className="bw-catalogue">
    <aside className="bw-courses"><header><h2>后端发布版本</h2></header><nav aria-label="选择发布版本">
      {data?.releases.map(entry => <button
        key={entry.release} aria-pressed={entry.release === data.selected} title={entry.release} onClick={() => select(entry.release)}>
        {entry.release === 'local' ? '本地开发版本' : entry.release.slice(0, 12)}</button>)}
    </nav></aside>
    <section className="bw-bank-panel">
      <header className="system-section-head"><h3>待清理兼容项</h3><Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button></header>
      {query.error && <ErrorState message={query.error.message} stale={!!data} onRetry={() => query.refetch()} />}
      {selected && !!data?.items.length && <p>开始采集 {formatDate(selected.firstSeen)} · 观测截至 {formatDate(data?.coverageThrough)}</p>}
      <Table rowKey="id" border={false} pagination={false} loading={query.isLoading} data={data?.items ?? []}
        noDataElement={<Empty description={selected ? "该版本早于采集功能，历史兼容清单和调用量未知" : "尚无版本采集记录"} />} columns={[
          { title: '兼容项', render: (_, item) => <div className="mg-entity"><strong>{item.name}</strong><small>{item.reason}</small></div> },
          { title: '引入记录 / 替代方式', render: (_, item) => <div className="mg-entity">{item.introduced}<small>{item.replacement}</small></div> },
          { title: '数据依赖', render: (_, item) => item.id === 'plain-default' ? `${data?.legacyRevisions} 个题目版本` : item.id === 'inline-fallback' ? '取决于客户端版本' : '历史来源无法识别' },
          { title: '近 7 天', render: (_, item) => count(item.id, 'week') },
          { title: '近 30 天', render: (_, item) => count(item.id, 'month') },
          { title: '最近调用', render: (_, item) => formatDate(data?.stats.find(row => row.item === item.id)?.lastSeen) },
        ]} />
      {data && <><p>{formatDate(data.checkedAt)} 统计，历史练习共引用 {data.practiceRevisions} 个题目版本，其中 {data.referencedRevisions} 个依赖旧版纯文本读取。</p>
        {data.gaps.length > 0 && <details><summary>查看近 30 天缺少观测的时段</summary>
          {data.gaps.map(gap => <p key={gap.start}>{formatDate(gap.start)} 至 {formatDate(gap.end)}</p>)}</details>}</>}
    </section>
  </section>
}
