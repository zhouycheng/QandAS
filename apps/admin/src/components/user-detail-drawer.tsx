import { Descriptions, Drawer, Spin } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { useAdminGateway } from '../gateways/gateway-context'
import { gradeLabel } from '../types/admin'
import { ErrorState } from './error-state'

export function UserDetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const gateway = useAdminGateway()
  const user = useQuery({ queryKey: ['user', id], queryFn: () => gateway.getUser(id) })
  const stats = useQuery({ queryKey: ['user-statistics', id], queryFn: () => gateway.getUserStatistics(id) })
  return <Drawer visible title="学生资料与学习摘要" width={560} onCancel={onClose} footer={null}>
    {(user.error || stats.error) && <ErrorState message={(user.error || stats.error)!.message} onRetry={() => { void user.refetch(); void stats.refetch() }} />}
    <Spin loading={user.isPending || stats.isPending}><Descriptions column={1} data={[
      { label: '昵称', value: user.data?.name }, { label: '账号', value: user.data?.account }, { label: '邮箱', value: user.data?.email },
      { label: '微信绑定', value: user.data?.wechatBound ? '已绑定' : '未绑定' },
      ...(user.data?.avatarUrl ? [{ label: '头像', value: <img src={user.data.avatarUrl} alt="账户头像" width={48} height={48} style={{ borderRadius: '50%' }} /> }] : []),
      { label: '学院', value: user.data?.collegeName || '未填写' }, { label: '专业', value: user.data?.majorName || '未填写' }, { label: '当前年级', value: gradeLabel(user.data?.grade) },
      { label: '已提交答题量', value: stats.data?.answeredCount ?? '—' }, { label: '正确题数', value: stats.data?.correctCount ?? '—' }, { label: '学习时长', value: stats.data ? Math.floor(stats.data.durationSeconds / 60) + ' 分钟' : '—' },
    ]} /></Spin>
  </Drawer>
}
