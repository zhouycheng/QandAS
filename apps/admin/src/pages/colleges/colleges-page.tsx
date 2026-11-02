import { useState } from 'react'
import { Button, Empty, Input, Select, Space, Table, Tag } from '@arco-design/web-react'
import { IconPlus, IconRefresh } from '@arco-design/web-react/icon'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import { GRADE_OPTIONS, gradeLabel, type College, type Major, type ContentStatus } from '../../types/admin'
import type { ManagedUser } from '../../types/operations'
import { DirectoryEditorModal, type EditorTarget } from './directory-editor-modal'
import { refreshWorkbench } from '../question-banks/workbench-data'

export function CollegesPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [college, setCollege] = useState<College>()
  const [major, setMajor] = useState<Major>()
  const [grade, setGrade] = useState<number>()
  const [page, setPage] = useState(1), [collegePage, setCollegePage] = useState(1)
  const [keyword, setKeyword] = useState(''), [collegeKeyword, setCollegeKeyword] = useState('')
  const [status, setStatus] = useState<ContentStatus>()
  const [editor, setEditor] = useState<EditorTarget>()
  const summary = useQuery({ queryKey: ['organization-directory', 'summary', college?.id, major?.id], queryFn: () => gateway.getDirectorySummary({ collegeId: college?.id, majorId: major?.id }) })
  const colleges = useQuery({ queryKey: ['organization-directory', 'colleges', collegePage, collegeKeyword], queryFn: () => gateway.listColleges({ page: collegePage, keyword: collegeKeyword }) })
  const majors = useQuery({ queryKey: ['organization-directory', 'majors', college?.id, page, keyword, status], enabled: Boolean(college && !major), queryFn: () => gateway.listMajors({ collegeId: college?.id, page, keyword, status }) })
  const students = useQuery({ queryKey: ['organization-directory', 'students', major?.id, grade, page, keyword], enabled: Boolean(major), queryFn: () => gateway.listUsers({ majorId: major?.id, collegeId: college?.id, grade, page, keyword }) })
  const selectCollege = (value?: College) => { setCollege(value); setMajor(undefined); setGrade(undefined); setPage(1); setKeyword(''); setStatus(undefined) }
  const refresh = () => refreshWorkbench(client)
  const current = major ? students : college ? majors : colleges
  const pagination = { current: major || college ? page : collegePage, pageSize: 20, total: current.data?.total ?? 0, showTotal: true, onChange: major || college ? setPage : setCollegePage }
  return <section className="directory-page" aria-label="院级管理">
    {summary.error && <ErrorState message={summary.error.message} onRetry={() => void summary.refetch()} />}
    <div className="directory-summary">
      {[['学院', summary.data?.collegeCount], ['当前范围专业', summary.data?.majorCount], ['当前范围学生', summary.data?.studentCount]].map(([label, count]) => <div className="directory-summary-item" key={label}><div><span>{label}</span><strong>{count ?? '—'}</strong></div></div>)}
    </div>
    <div className="directory-workspace">
      <aside className="directory-tree-panel">
        <div className="directory-panel-heading"><h2>学院目录</h2><Button type="text" icon={<IconPlus />} aria-label="新增学院" onClick={() => setEditor({ kind: 'college' })} /></div>
        <Input.Search aria-label="搜索学院" placeholder="搜索学院名称或代码" value={collegeKeyword} onChange={value => { setCollegeKeyword(value); setCollegePage(1) }} allowClear />
        <button className={`directory-all ${!college ? 'active' : ''}`} onClick={() => selectCollege()}>全部学院</button>
        {colleges.data?.items.map(row => <button key={row.id} className={`directory-all ${college?.id === row.id ? 'active' : ''}`} onClick={() => selectCollege(row)}>{row.name}<small>{row.studentCount ?? 0} 人</small></button>)}
        {colleges.error && <ErrorState message={colleges.error.message} onRetry={() => void colleges.refetch()} />}
        <Space><Button size="small" disabled={collegePage === 1} onClick={() => setCollegePage(p => p - 1)}>上一页</Button><Button size="small" disabled={collegePage * 20 >= (colleges.data?.total ?? 0)} onClick={() => setCollegePage(p => p + 1)}>下一页</Button></Space>
      </aside>
      <div className="directory-detail-panel">
        <div className="directory-path"><button onClick={() => selectCollege()}>全校目录</button>{college && <button onClick={() => selectCollege(college)}> / {college.name}</button>}{major && <span> / {major.name}</span>}</div>
        <div className="directory-detail-heading"><h2>{major ? major.name + ' · 学生' : college ? college.name + ' · 专业' : '全部学院'}</h2>{!major && <Button type="primary" icon={<IconPlus />} onClick={() => setEditor(college ? { kind: 'major', college } : { kind: 'college' })}>新增{college ? '专业' : '学院'}</Button>}</div>
        <div className="directory-toolbar">
          <Input.Search aria-label="搜索当前列表" placeholder={major ? '搜索昵称、账号或邮箱' : '搜索名称或代码'} value={college ? keyword : collegeKeyword} allowClear onChange={value => { if (college) { setKeyword(value); setPage(1) } else { setCollegeKeyword(value); setCollegePage(1) } }} />
          {major ? <Select aria-label="当前年级" placeholder="全部年级" allowClear value={grade} options={GRADE_OPTIONS.map(option => ({ ...option, label: option.label + ' · ' + (summary.data?.grades.find(g => g.grade === option.value)?.studentCount ?? 0) + ' 人' }))} onChange={value => { setGrade(value); setPage(1) }} /> : college && <Select aria-label="可选状态" placeholder="全部状态" value={status} allowClear onChange={value => { setStatus(value); setPage(1) }} options={[{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'INACTIVE' }]} />}
          <Button icon={<IconRefresh />} aria-label="刷新" loading={current.isFetching} onClick={refresh} />
        </div>
        {current.error && <ErrorState message={current.error.message} onRetry={() => void current.refetch()} />}
        {major ? <Table<ManagedUser> rowKey="id" data={students.data?.items ?? []} loading={students.isFetching} pagination={pagination} columns={[
          { title: '昵称', dataIndex: 'name' }, { title: '账号', dataIndex: 'account' }, { title: '年级', render: (_, row) => gradeLabel(row.grade) }, { title: '状态', render: (_, row) => row.status === 'ACTIVE' ? '正常' : row.status === 'DISABLED' ? '停用' : '待激活' },
        ]} /> : <Table<College | Major> rowKey="id" data={(college ? majors.data?.items : colleges.data?.items) ?? []} loading={current.isFetching} pagination={pagination} border={false} columns={[
          { title: '名称', render: (_, row) => <button className="directory-entity" onClick={() => { if ('collegeId' in row) { setMajor(row); setPage(1); setKeyword('') } else selectCollege(row) }}><span><strong>{row.name}</strong><small>{row.code}</small></span></button> },
          { title: '学生人数', dataIndex: 'studentCount' },
          { title: '可选状态', render: (_, row) => <Tag color={row.status === 'ACTIVE' ? 'green' : 'gray'}>{row.status === 'ACTIVE' ? '启用' : '停用'}</Tag> },
          { title: '操作', render: (_, row) => <Button type="text" onClick={() => setEditor('collegeId' in row ? { kind: 'major', college: college!, record: row } : { kind: 'college', record: row })}>编辑 / 停用</Button> },
        ]} noDataElement={<Empty description="暂无符合条件的目录" />} />}
        <p className="directory-detail-footer">人数按学生当前保存的资料归属统计。年级每年 9 月 1 日递增，已毕业保持不变。</p>
      </div>
    </div>
    {editor && <DirectoryEditorModal target={editor} onCancel={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); refresh() }} />}
  </section>
}
