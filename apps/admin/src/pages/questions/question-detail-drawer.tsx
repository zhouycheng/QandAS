import { ManagementDrawer as Drawer } from '../../components/management-drawer'
import { Skeleton, Space } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { StatusTag } from '../../components/status-tag'
import { useAdminGateway } from '../../gateways/gateway-context'
import { questionTypeLabels } from '../../lib/labels'
import type { QuestionBank } from '../../types/admin'
import { QuestionContentView } from './question-content-view'

export function QuestionDetailDrawer({ questionId, questionBanks, onClose }: { questionId?: string; questionBanks: QuestionBank[]; onClose: () => void }) {
  const gateway = useAdminGateway()
  const detail = useQuery({ queryKey: ['question-detail', questionId], queryFn: () => gateway.getQuestion(questionId!), enabled: Boolean(questionId) })
  const question = detail.data
  return <Drawer width={question?.type === 'READING' ? 720 : 560} style={{ maxWidth: '100vw' }} title={question?.type === 'READING' ? '阅读题组详情' : '题目详情'} visible={Boolean(questionId)} onCancel={onClose} footer={null} unmountOnExit>
    {detail.error && <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />}
    {detail.isLoading ? <Skeleton text={{ rows: 8 }} animation /> : question ? <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div className="op-meta"><strong>{questionBanks.find(bank => bank.id === question.questionBankId)?.name ?? '未知题库'}</strong>
        <span>{questionTypeLabels[question.type]}</span><StatusTag status={question.status} /><span>v{question.revision ?? 1}</span></div>
      <QuestionContentView question={question} />
    </Space> : null}
  </Drawer>
}
