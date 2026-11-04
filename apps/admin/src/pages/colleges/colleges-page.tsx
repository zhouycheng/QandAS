import { useState } from 'react'
import { Button, Empty, Input, Select, Space, Table, Tag } from '@arco-design/web-react'
import { IconPlus, IconRefresh } from '@arco-design/web-react/icon'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { College, Major, ContentStatus } from '../../types/admin'
import { DirectoryEditorModal, type EditorTarget } from './directory-editor-modal'
import { refreshWorkbench } from '../question-banks/workbench-data'

export function CollegesPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [college, setCollege] = useState<College>()
  const [page, setPage] = useState(1), [collegePage, setCollegePage] = useState(1)
  const [keyword, setKeyword] = useState(''), [collegeKeyword, setCollegeKeyword] = useState('')
  const [status, setStatus] = useState<ContentStatus>()
  const [editor, setEditor] = useState<EditorTarget>()
  const colleges = useQuery({ queryKey: ['organization-directory', 'colleges', collegePage, collegeKeyword], queryFn: () => gateway.listColleges({ page: collegePage, keyword: collegeKeyword }) })
  const majors = useQuery({ queryKey: ['organization-directory', 'majors', college?.id, page, keyword, status], enabled: Boolean(college), queryFn: () => gateway.listMajors({ collegeId: college?.id, page, keyword, status }) })
  const selectCollege = (value?: College) => { setCollege(value); setPage(1); setKeyword(''); setStatus(undefined) }
  const refresh = () => refreshWorkbench(client)
  const current = college ? majors : colleges
  const pagination = { current: college ? page : collegePage, pageSize: 20, total: current.data?.total ?? 0, showTotal: true, onChange: college ? setPage : setCollegePage }
  return <section className="directory-page" aria-label="题库分类管理">
    <div className="directory-workspace">
      <aside className="directory-tree-panel">
        <Input.Search aria-label="搜索学院" placeholder="搜索学院" value={collegeKeyword} allowClear onChange={value => { setCollegeKeyword(value); setCollegePage(1) }} />
        <Button long type="text" className={`directory-all ${!college ? 'active' : ''}`} aria-pressed={!college} onClick={() => selectCollege()}>全部学院</Button>
        {colleges.data?.items.map(item => <Button key={item.id} long type="text" className={`directory-all ${college?.id === item.id ? 'active' : ''}`} aria-pressed={college?.id === item.id} onClick={() => selectCollege(item)}>{item.name}</Button>)}
      </aside>
      <div className="directory-detail-panel">
        {college && <div className="directory-panel-heading"><h2>{college.name}</h2></div>}
        <div className="directory-toolbar">
          <Input.Search aria-label="搜索当前分类" placeholder="搜索名称或代码" value={college ? keyword : collegeKeyword} allowClear onChange={value => { if (college) { setKeyword(value); setPage(1) } else { setCollegeKeyword(value); setCollegePage(1) } }} />
          {college && <Select aria-label="可选状态" placeholder="全部状态" value={status} allowClear onChange={value => { setStatus(value); setPage(1) }} options={[{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'INACTIVE' }]} />}
          <Space>
            <Button icon={<IconRefresh />} aria-label="刷新" loading={current.isFetching} onClick={refresh} />
            <Button type="primary" icon={<IconPlus />} onClick={() => setEditor(college ? { kind: 'major', college } : { kind: 'college' })}>新增{college ? '专业' : '学院'}</Button>
          </Space>
        </div>
        {current.error && <ErrorState message={current.error.message} onRetry={() => void current.refetch()} />}
        <Table<College | Major> scroll={{ x: 520 }} rowKey="id" data={(college ? majors.data?.items : colleges.data?.items) ?? []} loading={current.isFetching} pagination={pagination} border={false} columns={[
          { title: '名称', render: (_, row) => <button className="directory-entity" onClick={() => { if ('collegeId' in row) setEditor({ kind: 'major', college: college!, record: row }); else selectCollege(row) }}><span><strong>{row.name}</strong><small>{row.code}</small></span></button> },
          { title: '可选状态', width: 100, render: (_, row) => <Tag color={row.status === 'ACTIVE' ? 'green' : 'gray'}>{row.status === 'ACTIVE' ? '启用' : '停用'}</Tag> },
          { title: '操作', width: 120, render: (_, row) => <Button type="text" onClick={() => setEditor('collegeId' in row ? { kind: 'major', college: college!, record: row } : { kind: 'college', record: row })}>编辑 / 停用</Button> },
        ]} noDataElement={<Empty description="暂无符合条件的分类" />} />
      </div>
    </div>
    {editor && <DirectoryEditorModal target={editor} onCancel={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); refresh() }} />}
  </section>
}
