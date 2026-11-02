import { useState } from 'react'
import { Alert, Button, Radio, Select, Tag } from '@arco-design/web-react'
import { IconDelete, IconEye, IconPlus } from '@arco-design/web-react/icon'
import { GRADE_OPTIONS } from '../../types/admin'
import type { QuestionBank, Subject } from '../../types/admin'
import { ResourceSelect } from '../../components/resource-select'
import { useScopeDirectory } from './scope-directory'
import { bankVisibility, emptyScopeGroup, groupsToAudiences, scopeLabels, type AudienceDirectory, type ScopeGroup } from '../../lib/bank-workbench'

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

export function ScopeEditor({ scopeType, groups, onTypeChange, onChange, disabled }: {
  scopeType: 'ALL' | 'TARGETED'
  groups: ScopeGroup[]
  onTypeChange: (type: 'ALL' | 'TARGETED') => void
  onChange: (groups: ScopeGroup[]) => void
  disabled: boolean
}) {
  const audiences = groupsToAudiences(groups)
  const directory = useScopeDirectory(audiences)
  const labels = scopeLabels({ scopeType, audiences }, directory)
  return <div className="bw-scope-editor">
    <h3>哪些学生可以看到这个题库？</h3>
    <Radio.Group className="bw-scope-mode" value={scopeType} disabled={disabled} onChange={onTypeChange}>
      <Radio value="ALL">全校可见</Radio><Radio value="TARGETED">指定范围</Radio>
    </Radio.Group>
    {scopeType === 'ALL' ? <Alert type="info" content="向全校学生展示，不限定学院、专业和当前年级。" /> : <>
      <p className="muted">每组条件同时满足，多组之间满足任意一组即可。下级选择“全部”表示不限定，面向全校请选择上方“全校可见”。</p>
      {groups.map((group, index) => <div className="bw-scope-group" key={group.id}>
        <div className="bw-scope-group-heading"><span>展示对象 {index + 1}</span><Button aria-label={`移除展示对象 ${index + 1}`} type="text" status="danger" icon={<IconDelete />} disabled={disabled} onClick={() => onChange(groups.filter((g) => g.id !== group.id))} /></div>
        <DirectorySelectors value={group} multipleGrades prefix={`展示对象${index + 1}`} disabled={disabled} onChange={(next) => onChange(groups.map((g) => g.id === group.id ? next : g))} />
      </div>)}
      <Button type="dashed" long icon={<IconPlus />} disabled={disabled} onClick={() => onChange([...groups, emptyScopeGroup()])}>添加一组展示范围</Button>
    </>}
    <div className="bw-scope-summary"><span>范围摘要</span>{labels.map((label) => <p key={label}>{label}</p>)}</div>
    <p className="bw-form-note">学生修改并保存院系资料后，重新匹配题库列表；已有学习记录保留。已停用分类可供原有归属学生匹配。</p>
  </div>
}

export function ScopePreview({ bank, subjects }: { bank: QuestionBank; directory: AudienceDirectory; subjects: Subject[] }) {
  const [profile, setProfile] = useState<ScopeGroup>({ id: 'preview', grades: [] })
  const result = bankVisibility(bank, { collegeId: profile.collegeId, majorId: profile.majorId, grade: profile.grades[0] }, subjects)
  const selected = bank.scopeType === 'ALL' || Boolean(profile.collegeId || profile.majorId || profile.grades.length)
  return <section className="bw-scope-preview">
    <div className="bw-section-heading"><h3><IconEye /> 学生资料匹配预览</h3><Tag color="arcoblue">预览</Tag></div>
    <p className="muted">选择一组学生资料，检查这个题库是否会出现在他的列表中。</p>
    <DirectorySelectors value={profile} onChange={setProfile} prefix="预览" />
    <div className={`bw-preview-result ${selected && result.visible ? 'is-visible' : ''}`} role="status">
      {selected ? <><Tag color={result.visible ? 'green' : result.matches ? 'orange' : 'gray'}>{result.visible ? '会展示' : result.matches ? '范围匹配' : '不展示'}</Tag><span>{result.message}</span></> : <span>请选择学生资料后查看匹配结果。</span>}
    </div>
  </section>
}
