import { Card } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'

export function DashboardPage() {
  const gateway = useAdminGateway()
  const summary = useQuery({ queryKey: ['dashboard-summary'], queryFn: () => gateway.getDashboardSummary() })
  const data = summary.data
  return <section aria-label="运营概览">
    {summary.error && <ErrorState message={summary.error.message} onRetry={() => void summary.refetch()} />}
    <div className="compact-metrics dashboard-metrics">
      {[['注册用户', data?.userCount], ['课程', data?.subjectCount], ['已发布题库', data?.publishedBankCount], ['题目总量', data?.questionCount]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value ?? '—'}</strong></div>)}
    </div>
    <div className="dashboard-content-grid">
      <Card bordered={false} title="内容待办">
        <Link className="quality-row" to="/feedback"><span>待处理题目反馈</span><strong>{data?.pendingFeedbackCount ?? '—'}</strong></Link>
        <Link className="quality-row" to="/feedback?kind=COURSE_REQUEST"><span>待处理缺课需求</span><strong>{data?.pendingCourseRequestCount ?? '—'}</strong></Link>
        <Link className="quality-row" to="/question-banks"><span>题库草稿</span><strong>{data?.draftBankCount ?? '—'}</strong></Link>
      </Card>
      <Card bordered={false} title="资源整理">
        {[['缺少解析的启用题目', data?.missingExplanationCount], ['尚未分章的题目', data?.unassignedQuestionCount], ['暂无有效题目的题库', data?.emptyBankCount]].map(([label, value]) => <div className="quality-row" key={label}><span>{label}</span><strong>{value ?? '—'}</strong></div>)}
        <div className="workflow-note"><strong>整理顺序</strong><p>课程 → 题库草稿 → 章节与题目 → 展示范围 → 检查发布</p></div>
      </Card>
    </div>
  </section>
}
