import type { BankAudience, College, Major, QuestionBank, Subject } from '../types/admin'
import { gradeLabel } from '../types/admin'
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

export function audienceLabels(bank: QuestionBank, colleges: College[], majors: Major[]) {
  return bank.scopeType === 'ALL'
    ? ['全校适用']
    : bank.audiences.map((a) =>
        [
          a.collegeId ? (colleges.find((c) => c.id === a.collegeId)?.name ?? '未知学院') : '',
          a.majorId ? (majors.find((m) => m.id === a.majorId)?.name ?? '未知专业') : '',
          a.grade ? gradeLabel(a.grade) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      )
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

export function isBankAvailable(bank: QuestionBank, subjects: Subject[]) {
  return (
    bank.publicationStatus === 'PUBLISHED' &&
    bank.status === 'ACTIVE' &&
    (bank.activeQuestionCount ?? 0) > 0 &&
    subjects.some((s) => s.id === bank.subjectId && s.status === 'ACTIVE')
  )
}

export function recommendedBanks(user: ManagedUser, banks: QuestionBank[], subjects: Subject[], grantedSubjectIds: string[] = []) {
  return banks.filter(
    (bank) =>
      isBankAvailable(bank, subjects) &&
      (grantedSubjectIds.includes(bank.subjectId) || bank.scopeType === 'ALL' || bank.audiences.some((audience) => matchesAudience(user, audience))),
  )
}
