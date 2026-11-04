import type { BankCategory, College, Major, QuestionBank, Subject } from '../types/admin'
import { gradeLabel } from '../types/admin'
import { matchesAudience } from './recommendations'

export interface AudienceDirectory {
  colleges: College[]
  majors: Major[]
}

export interface ScopeGroup { id: string; collegeId?: string; majorId?: string; grades: number[] }
export const emptyScopeGroup = (): ScopeGroup => ({ id: crypto.randomUUID(), grades: [] })

export function audienceGroups(categories: BankCategory[], directory: AudienceDirectory): ScopeGroup[] {
  const grouped = new Map<string, ScopeGroup>()
  const unlimited = new Set<string>()
  for (const audience of categories) {
    const collegeId = audience.collegeId ?? directory.majors.find((m) => m.id === audience.majorId)?.collegeId
    const key = `${collegeId ?? ''}/${audience.majorId ?? ''}`
    const group = grouped.get(key) ?? { id: key, collegeId, majorId: audience.majorId, grades: [] }
    if (audience.grade === undefined) { unlimited.add(key); group.grades = [] }
    else if (!unlimited.has(key)) group.grades = [...new Set([...group.grades, audience.grade])]
    grouped.set(key, group)
  }
  return [...grouped.values()]
}

export function groupsToCategories(groups: ScopeGroup[]): BankCategory[] {
  const categories = groups.flatMap((group) => {
    const base = { ...(group.collegeId ? { collegeId: group.collegeId } : {}), ...(group.majorId ? { majorId: group.majorId } : {}) }
    return group.grades.length ? group.grades.map((grade) => ({ ...base, grade })) : Object.keys(base).length ? [base] : []
  })
  return [...new Map(categories.map((a) => [JSON.stringify(a), a])).values()]
}

export function getScopeError(categories: BankCategory[], directory: AudienceDirectory) {
  for (const audience of categories) {
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

export function scopeLabels(bank: Pick<QuestionBank, 'categories'>, directory: AudienceDirectory) {
  if (!bank.categories.length) return ['通用题库']
  return bank.categories.map((audience) => {
    const major = directory.majors.find((m) => m.id === audience.majorId)
    const college = directory.colleges.find((c) => c.id === (audience.collegeId ?? major?.collegeId))
    return [college?.name || (audience.collegeId ? '所选学院' : ''), major?.name || (audience.majorId ? '所选专业' : ''), audience.grade ? gradeLabel(audience.grade) : undefined].filter(Boolean).join(' · ') || '展示范围待配置'
  })
}

export function bankVisibility(bank: QuestionBank, profile: Pick<BankCategory, 'collegeId' | 'majorId' | 'grade'>, subjects: Subject[]) {
  const matches = !bank.categories.length || bank.categories.some((a) => matchesAudience(profile, a))
  if (!matches) return { matches, visible: false, message: '题库不匹配当前筛选；仍可通过公开链接打开。' }
  if (bank.publicationStatus !== 'PUBLISHED') return { matches, visible: false, message: '分类匹配；题库发布后进入公开目录。' }
  if (!subjects.some((s) => s.id === bank.subjectId && s.status === 'ACTIVE')) return { matches, visible: false, message: '分类匹配，但所属课程已停用，暂不展示。' }
  if (bank.status !== 'ACTIVE' || !bank.activeQuestionCount) return { matches, visible: false, message: '分类匹配，但当前没有可练习的启用题目。' }
  return { matches, visible: true, message: '题库匹配当前筛选，并可公开浏览。' }
}
