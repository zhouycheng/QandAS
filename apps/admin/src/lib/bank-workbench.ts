import type { BankAudience, College, Major, QuestionBank, Subject } from '../types/admin'
import { gradeLabel } from '../types/admin'
import { matchesAudience } from './recommendations'

export interface AudienceDirectory {
  colleges: College[]
  majors: Major[]
}

export interface ScopeGroup { id: string; collegeId?: string; majorId?: string; grades: number[] }
export const emptyScopeGroup = (): ScopeGroup => ({ id: crypto.randomUUID(), grades: [] })

export function audienceGroups(audiences: BankAudience[], directory: AudienceDirectory): ScopeGroup[] {
  const grouped = new Map<string, ScopeGroup>()
  const unlimited = new Set<string>()
  for (const audience of audiences) {
    const collegeId = audience.collegeId ?? directory.majors.find((m) => m.id === audience.majorId)?.collegeId
    const key = `${collegeId ?? ''}/${audience.majorId ?? ''}`
    const group = grouped.get(key) ?? { id: key, collegeId, majorId: audience.majorId, grades: [] }
    if (audience.grade === undefined) { unlimited.add(key); group.grades = [] }
    else if (!unlimited.has(key)) group.grades = [...new Set([...group.grades, audience.grade])]
    grouped.set(key, group)
  }
  return [...grouped.values()]
}

export function groupsToAudiences(groups: ScopeGroup[]): BankAudience[] {
  const audiences = groups.flatMap((group) => {
    const base = { ...(group.collegeId ? { collegeId: group.collegeId } : {}), ...(group.majorId ? { majorId: group.majorId } : {}) }
    return group.grades.length ? group.grades.map((grade) => ({ ...base, grade })) : Object.keys(base).length ? [base] : []
  })
  return [...new Map(audiences.map((a) => [JSON.stringify(a), a])).values()]
}

export function getScopeError(scopeType: string, audiences: BankAudience[], directory: AudienceDirectory, required = true) {
  if (!['ALL', 'TARGETED'].includes(scopeType)) return '请选择展示范围类型。'
  if (scopeType === 'ALL') return
  if (!audiences.length && required) return '请至少添加一条有效展示条件。'
  for (const audience of audiences) {
    if (!audience.collegeId && !audience.majorId && audience.grade === undefined)
      return '每条展示条件至少填写一个条件。'
    if (audience.collegeId && !directory.colleges.some((c) => c.id === audience.collegeId))
      return '展示学院不存在，请重新选择。'
    if (audience.majorId && !directory.majors.some((m) => m.id === audience.majorId && (!audience.collegeId || m.collegeId === audience.collegeId)))
      return '展示专业不存在或不属于所选学院。'
    if (audience.grade !== undefined && (!Number.isInteger(audience.grade) || audience.grade < 1 || audience.grade > 5))
      return '请选择大一至已毕业的年级。'
  }
}

export function scopeLabels(bank: Pick<QuestionBank, 'scopeType' | 'audiences'>, directory: AudienceDirectory) {
  if (bank.scopeType === 'ALL') return ['全校可见']
  if (!bank.audiences.length) return ['展示范围待配置']
  return bank.audiences.map((audience) => {
    const major = directory.majors.find((m) => m.id === audience.majorId)
    const college = directory.colleges.find((c) => c.id === (audience.collegeId ?? major?.collegeId))
    return [college?.name || (audience.collegeId ? '所选学院' : ''), major?.name || (audience.majorId ? '所选专业' : ''), audience.grade ? gradeLabel(audience.grade) : undefined].filter(Boolean).join(' · ') || '展示范围待配置'
  })
}

export function bankVisibility(bank: QuestionBank, profile: Pick<BankAudience, 'collegeId' | 'majorId' | 'grade'>, subjects: Subject[]) {
  const matches = bank.scopeType === 'ALL' || bank.audiences.some((a) => matchesAudience({ collegeId: profile.collegeId ?? '', majorId: profile.majorId ?? '', grade: profile.grade }, a))
  if (!matches) return { matches, visible: false, message: '该学生资料不在题库的展示范围内。' }
  if (bank.publicationStatus !== 'PUBLISHED') return { matches, visible: false, message: '资料匹配；题库发布后才会在学生列表中展示。' }
  if (!subjects.some((s) => s.id === bank.subjectId && s.status === 'ACTIVE')) return { matches, visible: false, message: '资料匹配，但所属课程已停用，暂不展示。' }
  if (bank.status !== 'ACTIVE' || !bank.activeQuestionCount) return { matches, visible: false, message: '资料匹配，但当前没有可练习的启用题目。' }
  return { matches, visible: true, message: '该学生将在答题端看到这个题库。' }
}
