import { useEffect, useState } from 'react'
import { Alert, Button, Card, Radio, Select, Space, Table } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { LineChart } from '../../components/charts'
import { UserDetailDrawer } from '../../components/user-detail-drawer'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { ActivityQuery, RankingRow } from '../../types/operations'
import { OnlineUsersDrawer } from './online-users-drawer'

export function ActivityPage() {
  const gateway = useAdminGateway()
  const [visible, setVisible] = useState(!document.hidden)
  useEffect(() => { const update = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update) }, [])
  const filters = {}
  const [trendPeriod, setTrendPeriod] = useState<'WEEK' | 'MONTH'>('WEEK')
  const [period, setPeriod] = useState<ActivityQuery['period']>('WEEK')
  const [sort, setSort] = useState<ActivityQuery['sort']>('ACTIVE_DAYS')
  const [page, setPage] = useState(1), [userId, setUserId] = useState<string>()
  const [onlineOpen, setOnlineOpen] = useState(false)
  const cards = useQuery({ queryKey: ['activity', 'cards', filters], queryFn: () => gateway.getActivity({ ...filters, period: 'DAY' }), enabled: visible, refetchInterval: visible ? 30000 : false, refetchIntervalInBackground: false })
  const trend = useQuery({ queryKey: ['activity', 'trend', filters, trendPeriod], queryFn: () => gateway.getActivity({ ...filters, period: trendPeriod }), enabled: visible, refetchInterval: visible ? 60000 : false, refetchIntervalInBackground: false })
  const rankings = useQuery({ queryKey: ['activity', 'rankings', filters, period, sort, page], queryFn: () => gateway.getRankings({ ...filters, period, sort, page, pageSize: 20 }), enabled: visible, refetchInterval: visible ? 60000 : false, refetchIntervalInBackground: false })
  const failed = cards.error || trend.error || rankings.error
  return <section className="activity-page page-stack" aria-label="活跃度监控">
    {failed && <Alert type="warning" content={'更新失败：' + failed.message + '。已有数据保留，以下时间为最近成功更新。'} action={<Button onClick={() => { void cards.refetch(); void trend.refetch(); void rankings.refetch() }}>重试</Button>} />}
    <div className="compact-metrics dashboard-metrics">
      <button className="metric-link" onClick={() => setOnlineOpen(true)}><span>当前在线 ↗</span><strong>{cards.data?.onlineUsers ?? '—'}</strong></button>
      {[['今日活跃 DAU', cards.data?.dailyActive], ['近 7 天活跃 WAU', cards.data?.weeklyActive], ['近 30 天活跃 MAU', cards.data?.monthlyActive]].map(([label, count]) => <div key={label}><span>{label}</span><strong>{count ?? '—'}</strong></div>)}
    </div>
    <p className="muted">人数更新：{cards.data?.updatedAt ? new Date(cards.data.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '等待数据'} · 北京时间 · 登录学生按账号去重</p>
    <Card title="每日活跃人数" bordered={false} extra={<Radio.Group type="button" value={trendPeriod} onChange={setTrendPeriod}><Radio value="WEEK">近 7 天</Radio><Radio value="MONTH">近 30 天</Radio></Radio.Group>}>
      <LineChart label="每日活跃人数" data={trend.data?.records.map(r => ({ label: r.date, value: r.activeUsers })) ?? []} />
      <p className="muted">趋势更新：{trend.data?.updatedAt ? new Date(trend.data.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '等待数据'}；无活动的日期显示为零。</p>
    </Card>
    <Card title="用户活跃排行榜" bordered={false} className="section-gap">
      <Space wrap className="list-toolbar list-toolbar-separated"><div className="field-label">统计周期 <Select style={{ width: 140 }} aria-label="统计周期" value={period} onChange={value => { setPeriod(value); setPage(1) }} options={[{ value: 'DAY', label: '今日' }, { value: 'WEEK', label: '近 7 天' }, { value: 'MONTH', label: '近 30 天' }, { value: 'ALL', label: '累计' }]} /></div>
        <div className="field-label">排序方式 <Select style={{ width: 160 }} aria-label="排序方式" value={sort} onChange={value => { setSort(value); setPage(1) }} options={[{ value: 'ACTIVE_DAYS', label: '活跃天数' }, { value: 'ANSWERED_COUNT', label: '答题量' }, { value: 'DURATION', label: '学习时长' }]} /></div>
      </Space>
      <Table<RankingRow> rowKey="userId" data={rankings.data?.items ?? []} loading={rankings.isFetching} scroll={{ x: 1300 }} pagination={{ current: page, pageSize: 20, total: rankings.data?.total ?? 0, onChange: setPage, showTotal: true }} columns={[
        { title: '名次', dataIndex: 'rank', width: 65 }, { title: '昵称', width: 120, render: (_, row) => <Button type="text" onClick={() => setUserId(row.userId)}>{row.nickname}</Button> }, { title: '账号', dataIndex: 'accountCode', width: 120 },
        { title: '活跃天数', dataIndex: 'activeDays', width: 100 }, { title: '答题量', dataIndex: 'answeredCount', width: 100 }, { title: '学习时长', width: 110, render: (_, row) => Math.floor(row.durationSeconds / 60) + ' 分钟' }, { title: '最近活跃', width: 180, render: (_, row) => row.lastActiveAt ? new Date(row.lastActiveAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—' },
      ]} />
      <p className="muted">榜单更新：{rankings.dataUpdatedAt ? new Date(rankings.dataUpdatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '等待数据'}。答题量与学习时长按已提交正式练习统计。</p>
    </Card>
    {userId && <UserDetailDrawer id={userId} onClose={() => setUserId(undefined)} />}
    {onlineOpen && <OnlineUsersDrawer filters={filters} visible={visible} onClose={() => setOnlineOpen(false)} />}
  </section>
}
