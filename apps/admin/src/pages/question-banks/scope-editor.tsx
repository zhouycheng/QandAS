import { useState } from 'react'
import { Button, Select, Tag } from '@arco-design/web-react'
import { IconDelete, IconEye, IconPlus } from '@arco-design/web-react/icon'
import { GRADE_OPTIONS } from '../../types/admin'
import type { QuestionBank, Subject } from '../../types/admin'
import { ResourceSelect } from '../../components/resource-select'
import { useScopeDirectory } from './scope-directory'
import { bankVisibility, emptyScopeGroup, groupsToCategories, scopeLabels, type AudienceDirectory, type ScopeGroup } from '../../lib/bank-workbench'

export function DirectorySelectors({ value, onChange, multipleGrades = false, disabled = false, prefix }: {
  value: ScopeGroup
  onChange: (value: ScopeGroup) => void
  multipleGrades?: boolean
  disabled?: boolean
  prefix: string
}) {
  return <div className="bw-directory-selectors">
    <div className="field-label"><span>学院</span><ResourceSelect kind="college" placeholder={prefix + '学院'} value={value.collegeId} disabled={disabled} onChange={collegeId => onChange({ ...value, collegeId: String(collegeId || '') || undefined, majorId: undefined })} /></div>
    <div className="field-label"><span>专业</span><ResourceSelect kind="major" collegeId={value.collegeId} placeholder={prefix + '专业'} value={value.majorId} disabled={disabled} onChange={majorId => onChange({ ...value, majorId: String(majorId || '') || undefined })} /></div>
    <div className="field-label"><span>当前年级{multipleGrades ? '（可多选）' : ''}</span><Select aria-label={`${prefix}年级`} value={multipleGrades ? value.grades : value.grades[0]} mode={multipleGrades ? 'multiple' : undefined}
      placeholder={multipleGrades ? '全部年级' : '选择当前年级'} allowClear disabled={disabled} showSearch
      onChange={(year) => onChange({ ...value, grades: multipleGrades ? year : year === undefined ? [] : [year] })}
      options={GRADE_OPTIONS} /></div>
  </div>
}

export function ScopeEditor({ groups, onChange, disabled }: {
  groups: ScopeGroup[]
  onChange: (groups: ScopeGroup[]) => void
  disabled: boolean
}) {
  const categories = groupsToCategories(groups)
  const directory = useScopeDirectory(categories)
  const labels = scopeLabels({ categories }, directory)
  return <div className="bw-scope-editor">
    <h3>题库分类</h3>
      <p className="muted">分类用于学生自由筛选。每组内同时匹配，多组取并集；留空表示通用题库。</p>
      {groups.map((group, index) => <div className="bw-scope-group" key={group.id}>
        <div className="bw-scope-group-heading"><span>分类 {index + 1}</span><Button aria-label={`移除分类 ${index + 1}`} type="text" status="danger" icon={<IconDelete />} disabled={disabled} onClick={() => onChange(groups.filter((g) => g.id !== group.id))} /></div>
        <DirectorySelectors value={group} multipleGrades prefix={`分类${index + 1}`} disabled={disabled} onChange={(next) => onChange(groups.map((g) => g.id === group.id ? next : g))} />
      </div>)}
      <Button type="dashed" long icon={<IconPlus />} disabled={disabled} onClick={() => onChange([...groups, emptyScopeGroup()])}>添加分类</Button>
    <div className="bw-scope-summary"><span>分类摘要</span>{labels.map((label) => <p key={label}>{label}</p>)}</div>
  </div>
}

export function ScopePreview({ bank, subjects }: { bank: QuestionBank; directory: AudienceDirectory; subjects: Subject[] }) {
  const [profile, setProfile] = useState<ScopeGroup>({ id: 'preview', grades: [] })
  const result = bankVisibility(bank, { collegeId: profile.collegeId, majorId: profile.majorId, grade: profile.grades[0] }, subjects)
  const selected = true
  return <section className="bw-scope-preview">
    <div className="bw-section-heading"><h3><IconEye /> 分类筛选预览</h3><Tag color="arcoblue">预览</Tag></div>
    <p className="muted">选择分类，检查题库是否出现在筛选结果中。</p>
    <DirectorySelectors value={profile} onChange={setProfile} prefix="预览" />
    <div className={`bw-preview-result ${selected && result.visible ? 'is-visible' : ''}`} role="status">
      {selected ? <><Tag color={result.visible ? 'green' : result.matches ? 'orange' : 'gray'}>{result.visible ? '会展示' : result.matches ? '范围匹配' : '不展示'}</Tag><span>{result.message}</span></> : <span>请选择学生资料后查看匹配结果。</span>}
    </div>
  </section>
}
