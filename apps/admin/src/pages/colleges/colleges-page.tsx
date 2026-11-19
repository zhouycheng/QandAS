import { useState } from 'react'
import { Button, Empty, Input, Select, Space, Table, Tag } from '@arco-design/web-react'
import { IconPlus, IconRefresh } from '@arco-design/web-react/icon'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ResourceSelect } from '../../components/resource-select'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { College, Major, ContentStatus } from '../../types/admin'
import { DirectoryEditorModal, type EditorTarget } from './directory-editor-modal'
import { refreshWorkbench } from '../question-banks/workbench-data'

export function CollegesPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [collegeId, setCollegeId] = useState<string>()
  const selected = useQuery({ queryKey: ['organization-directory', 'college', collegeId], enabled: !!collegeId, queryFn: () => gateway.getCollege(collegeId!) })
  const college = selected.data
  const [page, setPage] = useState(1), [collegePage, setCollegePage] = useState(1)
  const [keyword, setKeyword] = useState(''), [collegeKeyword, setCollegeKeyword] = useState('')
  const [status, setStatus] = useState<ContentStatus>()
  const [editor, setEditor] = useState<EditorTarget>()
  const colleges = useQuery({ enabled: !collegeId, queryKey: ['organization-directory', 'colleges', collegePage, collegeKeyword], queryFn: () => gateway.listColleges({ page: collegePage, keyword: collegeKeyword }) })
  const majors = useQuery({ queryKey: ['organization-directory', 'majors', collegeId, page, keyword, status], enabled: Boolean(collegeId), queryFn: () => gateway.listMajors({ collegeId, page, keyword, status }) })
  const selectCollege = (value?: College) => { if (value) client.setQueryData(['organization-directory', 'college', value.id], value); setCollegeId(value?.id); setPage(1); setKeyword(''); setStatus(undefined) }
  const refresh = () => refreshWorkbench(client)
  const current = collegeId ? majors : colleges
  const pagination = { current: collegeId ? page : collegePage, pageSize: 20, total: current.data?.total ?? 0, showTotal: true, onChange: collegeId ? setPage : setCollegePage }
  return <section className="directory-page" aria-label="院级管理">
    <div className="op-sheet">
      {collegeId && <div className="work-title directory-context"><Button type="text" onClick={() => selectCollege()}>全部学院</Button>
        <ResourceSelect kind="college" placeholder="切换学院" value={collegeId} initialOptions={college ? [{label: college.name, value: college.id}] : []}
          onChange={value => { setCollegeId(String(value || '') || undefined); setKeyword(''); setPage(1); setStatus(undefined) }} />
        {selected.error && <ErrorState stale={!!selected.data} message={selected.error.message} onRetry={() => void selected.refetch()} />}
      </div>}
        <div className="directory-toolbar">
          <Input.Search aria-label="搜索当前分类" placeholder="搜索名称或代码" value={collegeId ? keyword : collegeKeyword} allowClear onChange={value => { if (collegeId) { setKeyword(value); setPage(1) } else { setCollegeKeyword(value); setCollegePage(1) } }} />
          {collegeId && <Select aria-label="可选状态" placeholder="全部状态" value={status} allowClear onChange={value => { setStatus(value); setPage(1) }} options={[{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'INACTIVE' }]} />}
          <Space>
            <Button icon={<IconRefresh />} aria-label="刷新" loading={current.isFetching} onClick={refresh} />
            <Button disabled={!!collegeId && !college} type="primary" icon={<IconPlus />} onClick={() => setEditor(college ? { kind: 'major', college } : { kind: 'college' })}>新增{collegeId ? '专业' : '学院'}</Button>
          </Space>
        </div>
        {current.error && <ErrorState stale={!!current.data} message={current.error.message} onRetry={() => void current.refetch()} />}
        <Table<College | Major>  rowKey="id" data={current.data?.items ?? []} loading={current.isFetching} pagination={pagination} border={false} columns={[
          { title: '名称', render: (_, row) => <button className="directory-entity" disabled={'collegeId' in row && !college} onClick={() => { if ('collegeId' in row) setEditor({ kind: 'major', college: college!, record: row }); else selectCollege(row) }}><span><strong>{row.name}</strong></span></button> },
          { title: '代码', dataIndex: 'code' },
          { title: '可选状态', width: 100, render: (_, row) => <Tag color={row.status === 'ACTIVE' ? 'green' : 'gray'}>{row.status === 'ACTIVE' ? '启用' : '停用'}</Tag> },
          ...(collegeId ? [] : [{ title: '操作', width: 88, render: (_: unknown, row: College | Major) => !('collegeId' in row) && <Button type="text" onClick={() => setEditor({ kind: 'college', record: row })}>编辑</Button> }]),
        ]} noDataElement={<Empty description={current.error ? '名单加载失败' : keyword || status || (!collegeId && collegeKeyword) ? '没有符合条件的记录' : collegeId ? '该学院暂无专业' : '暂无学院'} />} />
    </div>
    {editor && <DirectoryEditorModal target={editor} onCancel={() => setEditor(undefined)} onSaved={refresh} />}
  </section>
}
