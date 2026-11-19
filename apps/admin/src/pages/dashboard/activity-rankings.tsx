import { useState } from 'react'
import { Alert, Button, Radio, Table } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { UserDetailDrawer } from '../../components/user-detail-drawer'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { ActivityQuery, RankingRow } from '../../types/operations'

import { ActivityPeriodSelect, type ActivityPeriod } from './activity-period'

export function ActivityRankings() {
  const gateway = useAdminGateway()
  const [period, setPeriod] = useState<ActivityPeriod>('WEEK')
  const [sort, setSort] = useState<ActivityQuery['sort']>('ACTIVE_DAYS')
  const [page, setPage] = useState(1), [userId, setUserId] = useState<string>()
  const rankings = useQuery({ queryKey: ['activity', 'rankings', period, sort, page], queryFn: () => gateway.getRankings({ period, sort, page, pageSize: 20 }), refetchInterval: 60000, refetchIntervalInBackground: false })
  return <section id="activity-rankings" className="ops-panel ops-wide" aria-label="用户活跃排行榜">
    <header className="ranking-header"><h2>用户活跃排行榜</h2>
    <div className="ranking-filters">
      <div className="ranking-filter">
        <span>统计周期</span>
        <ActivityPeriodSelect name="ranking-period" label="统计周期" value={period} onChange={value => { setPeriod(value); setPage(1) }} />
      </div>
      <div className="ranking-filter">
        <span id="ranking-sort">排序方式</span>
        <Radio.Group className="ops-segments" type="button" name="ranking-sort" aria-labelledby="ranking-sort" value={sort} onChange={value => { setSort(value); setPage(1) }}>
          <Radio value="ACTIVE_DAYS">活跃天数</Radio><Radio value="ANSWERED_COUNT">答题量</Radio><Radio value="DURATION">学习时长</Radio>
        </Radio.Group>
      </div>
    </div>
    </header>
    {rankings.error && <Alert type="warning" content={rankings.error.message} action={<Button onClick={() => void rankings.refetch()}>重试</Button>} />}
      {rankings.data?.total === 0 ? <p className="ops-message">该周期暂无活跃学生</p> : <Table<RankingRow> rowKey="userId" data={rankings.data?.items ?? []} loading={rankings.isFetching} scroll={{ x: 810 }} pagination={{ current: page, pageSize: 20, total: rankings.data?.total ?? 0, onChange: setPage, showTotal: true }} columns={[
        { title: '名次', align: 'right', dataIndex: 'rank', width: 65 }, { title: '昵称', width: 120, render: (_, row) => <Button type="text" onClick={() => setUserId(row.userId)}>{row.nickname}</Button> }, { title: '账号', dataIndex: 'accountCode', width: 120 },
        { title: '活跃天数', align: 'right', dataIndex: 'activeDays', width: 100 }, { title: '答题量', align: 'right', dataIndex: 'answeredCount', width: 100 }, { title: '学习时长', align: 'right', width: 110, render: (_, row) => Math.floor(row.durationSeconds / 60) + ' 分钟' }, { title: '最近活跃', width: 180, render: (_, row) => row.lastActiveAt ? new Date(row.lastActiveAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—' },
      ]} />}
      <p className="muted">榜单更新：{rankings.dataUpdatedAt ? new Date(rankings.dataUpdatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '等待数据'}。答题量与学习时长按已提交正式练习统计。</p>
    {userId && <UserDetailDrawer id={userId} onClose={() => setUserId(undefined)} />}
  </section>
}
