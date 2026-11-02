import type { BankAudience } from '../types/admin'
import type { ManagedUser } from '../types/operations'

export const publicationLabels = {
  DRAFT: '草稿',
  PUBLISHED: '已发布',
  UNPUBLISHED: '已下架',
  ARCHIVED: '已归档',
}
export const publicationColors = {
  DRAFT: 'gray',
  PUBLISHED: 'green',
  UNPUBLISHED: 'orange',
  ARCHIVED: 'gray',
}
export const feedbackStatusLabels = {
  OPEN: '待处理',
  IN_PROGRESS: '处理中',
  RESOLVED: '已解决',
  DISMISSED: '无需修改',
}
export const courseRequestStatusLabels = {
  OPEN: '待评估',
  IN_PROGRESS: '整理中',
  RESOLVED: '已补充',
  DISMISSED: '暂不收录',
}

export function matchesAudience(
  user: Pick<ManagedUser, 'collegeId' | 'majorId' | 'grade'>,
  audience: BankAudience,
) {
  return (
    Boolean(audience.collegeId || audience.majorId || audience.grade) &&
    (!audience.collegeId || audience.collegeId === user.collegeId) &&
    (!audience.majorId || audience.majorId === user.majorId) &&
    (!audience.grade || audience.grade === user.grade)
  )
}
