import { useEffect, useRef, useState } from 'react'
import { Pagination } from '@arco-design/web-react'
import { IconBook, IconNotification, IconQrcode } from '@arco-design/web-react/icon'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import { LineChart } from '../../components/charts'
import { useAdminGateway } from '../../gateways/gateway-context'
import { communityGroupDate } from '../../lib/community-group-expiry'
import { ActivityPeriodSelect, periodLabels, type ActivityPeriod } from './activity-period'
import { ActivityRankings } from './activity-rankings'
import { OnlineUsersPanel } from './online-users-panel'
import './dashboard.css'

function QueryStatus({ query }: { query: UseQueryResult<unknown, Error> }) {
  if (query.error) return <p role="alert" className="ops-message">{query.error.message} <button onClick={() => void query.refetch()}>重试</button></p>
  return query.isPending ? <p className="ops-message" role="status">加载中…</p> : null
}

function ActivityPanel() {
  const gateway = useAdminGateway()
  const [period, setPeriod] = useState<ActivityPeriod>('WEEK')
  const query = useQuery({ queryKey: ['activity', 'trend', {}, period], queryFn: () => gateway.getActivity({ period }), refetchInterval: 60000 })
  const data = query.isError ? undefined : query.data
  const panel = useRef<HTMLElement>(null)
  const [chartWidth, setChartWidth] = useState(600)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setChartWidth(Math.max(280, entry.contentRect.width)))
    observer.observe(panel.current!)
    return () => observer.disconnect()
  }, [])
  return <section ref={panel} className="ops-panel ops-activity">
    <header><h2>学生活跃</h2><ActivityPeriodSelect name="trend-period" label="趋势周期" value={period} onChange={setPeriod} /></header>
    <div className="ops-numbers">
      <div><span>{periodLabels[period]}活跃人数</span><strong>{data?.activeUsers ?? '—'}</strong></div>
      {period !== 'DAY' && <div><span>今日活跃</span><b>{data?.dailyActive ?? '—'}</b></div>}
      <div><span>当前在线</span><b>{data?.onlineUsers ?? '—'}</b></div>
    </div>
    <div className="ops-chart-caption"><span>每日活跃人数{data && ' · ' + new Date(data.updatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }) + ' 更新'}</span></div>
    <div className="ops-plot">
      <LineChart height={200} showEmptyAxes width={chartWidth} label="每日活跃人数" data={data?.records.map(row => ({ label: row.date, value: row.activeUsers })) ?? []}>
      {query.isError ? <span className="ops-message" role="alert">数据加载失败 <button onClick={() => void query.refetch()} disabled={query.isFetching}>重试</button></span>
        : query.isPending ? <span role="status">加载中…</span>
        : data?.records.every(row => row.activeUsers === 0) && <span>本期暂无学生活跃记录</span>}
      </LineChart>
    </div>
  </section>
}

function WorkPanel() {
  const gateway = useAdminGateway()
  const query = useQuery({ queryKey: ['dashboard-summary'], queryFn: () => gateway.getDashboardSummary() })
  const d = query.data
  const tasks = [
    ['处理题目纠错', d?.pendingFeedbackCount, '条', '/feedback?kind=QUESTION&status=PENDING'],
    ['处理缺课需求', d?.pendingCourseRequestCount, '条', '/feedback?kind=COURSE_REQUEST&status=PENDING'],
    ['整理题库草稿', d?.draftBankCount, '个', '#draft-banks'],
    ['为题目分章', d?.unassignedQuestionCount, '道', '/question-banks?quality=unassigned'],
    ['补充启用题目解析', d?.missingExplanationCount, '道', '/question-banks?quality=missingExplanation'],
    ['整理空题库', d?.emptyBankCount, '个', '/question-banks?quality=empty'],
  ] as const
  const pending = tasks.filter(([, count]) => (count ?? 0) > 0)
  return <section className="ops-panel ops-work">
    <QueryStatus query={query} />
    {pending.length > 0 && <section>
      <h2>运营待办</h2>
      {pending.map(([name, n, unit, url]) =>
        <Link className="ops-task" key={name} to={url}><span>{name}</span><b>{n} {unit} ›</b></Link>)}
    </section>}
    <section><h2>平台规模</h2><div className="ops-scale">{([
      ['注册用户', d?.userCount], ['课程', d?.subjectCount],
      ['已发布题库', d?.publishedBankCount], ['题目总量', d?.questionCount],
    ] as const).map(([label, n]) => <div key={label}><span>{label}</span><b>{n ?? '—'}</b></div>)}</div></section>
  </section>
}

function DraftPanel() {
  const gateway = useAdminGateway()
  const [page, setPage] = useState(1)
  const query = useQuery({ queryKey: ['question-banks', 'dashboard-drafts', page], queryFn: () => gateway.listQuestionBanks({ publicationStatus: 'DRAFT', page, pageSize: 4 }) })
  return <section id="draft-banks" className="ops-panel"><header><h2>继续整理题库</h2></header>
    <QueryStatus query={query} />
    <div className="ops-drafts">
      {query.data?.items.map(bank => <Link className="ops-draft" key={bank.id} to={'/question-banks/' + bank.id}>
        <IconBook aria-hidden="true" />
        <div><strong title={bank.name}>{bank.name}</strong>
          <small>{bank.questionCount} 道题<span aria-hidden="true"> · </span><time dateTime={bank.updatedAt}>{communityGroupDate(new Date(bank.updatedAt))} 更新</time></small>
        </div>
      </Link>)}
    </div>
    {query.data && query.data.total > 4 && <Pagination size="small" current={page} pageSize={4} total={query.data.total} onChange={setPage} />}
    {query.data?.items.length === 0 && <p className="ops-message">暂无题库草稿</p>}
  </section>
}

function CommunityPanel() {
  const gateway = useAdminGateway()
  const notices = useQuery({ queryKey: ['announcements', 'dashboard'], queryFn: () => gateway.listAnnouncements({ pageSize: 3 }) })
  const group = useQuery({ queryKey: ['community-group'], queryFn: () => gateway.getCommunityGroup(), refetchInterval: 60000 })
  const g = group.data
  const valid = g?.available && g.expiresAt && Date.parse(g.expiresAt) > Date.now()
  return <section className="ops-panel ops-community"><header><h2>公告与社群</h2></header>
    <QueryStatus query={notices} />
    {notices.data?.items.map(row => <div className="ops-notice" key={row.id}><strong>{row.pinned && <small>置顶 </small>}{row.title}</strong><span>{{ DRAFT: '草稿', PUBLISHED: '已发布', SCHEDULED: '定时发布' }[row.status]}</span></div>)}
    {notices.data?.items.length === 0 && <p className="ops-no-notices"><IconNotification aria-hidden="true" />暂无公告</p>}
    <div className="ops-group"><IconQrcode aria-hidden="true" /><div><strong>交流群二维码</strong>{g?.expiresAt && <small>{communityGroupDate(new Date(g.expiresAt))} 到期</small>}</div>
      {g && <span className="ops-group-state">{valid ? '有效' : g.expiresAt ? '已过期' : '未设置'}</span>}</div><QueryStatus query={group} />
  </section>
}

export function DashboardPage() {
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash])
  return <section className="ops-overview" aria-label="运营概览"><div className="ops-grid"><ActivityPanel /><WorkPanel /><ActivityRankings /><OnlineUsersPanel /><DraftPanel /><CommunityPanel /></div></section>
}
