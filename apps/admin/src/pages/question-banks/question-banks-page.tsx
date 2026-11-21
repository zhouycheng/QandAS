import { useState } from 'react'
import { Button, Dropdown, Empty, Input, Menu, Message, Modal, Pagination, Select, Space, Switch, Table, Tag } from '@arco-design/web-react'
import { IconBook, IconMore, IconPlus, IconRefresh } from '@arco-design/web-react/icon'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ErrorState } from '../../components/error-state'
import { ApiError } from '../../gateways/api-error'
import { useAdminGateway } from '../../gateways/gateway-context'
import { publicationColors, publicationLabels } from '../../lib/recommendations'
import type { BankPublicationStatus, QuestionBank, Subject } from '../../types/admin'
import { BankSettingsDrawer } from './bank-settings-drawer'
import { CourseEditorModal } from './course-editor-modal'
import { refreshWorkbench } from './workbench-data'

function CourseHeading({ course }: { course: Subject }) {
  const gateway = useAdminGateway()
  const client = useQueryClient()
  const [draft, setDraft] = useState<Subject>()
  const [editing, setEditing] = useState<Subject>()
  const current = draft ?? course
  const save = useMutation({
    mutationFn: (edited: Subject) => gateway.updateSubject(edited.id, {
      name: edited.name.trim(), status: edited.status, description: edited.description, expectedVersion: edited.version,
    }),
    onSuccess: saved => {
      client.setQueryData(['subjects', saved.id], { ...course, ...saved })
      setDraft(undefined)
      refreshWorkbench(client)
      Message.success('课程已保存')
    },
    onError: error => {
      if (error instanceof ApiError && error.status === 409) {
        void client.invalidateQueries({ queryKey: ['subjects', course.id] })
      }
    },
  })
  function edit(changes: Partial<Pick<Subject, 'name' | 'status'>>) {
    const next = { ...current, ...changes }
    setDraft(next.name === course.name && next.status === course.status ? undefined : next)
    save.reset()
  }
  const stale = draft && draft.version !== course.version
  return <div className="course-heading">
    <div className="course-heading-fields">
      <input className="course-name" aria-label="课程名称" title="编辑课程名称" maxLength={120}
        value={current.name} disabled={save.isPending} onChange={event => edit({ name: event.target.value })} />
      <label className="course-visibility"><Switch aria-label="开放本课程题库" size="small"
        checked={current.status === 'ACTIVE'} disabled={save.isPending}
        onChange={checked => edit({ status: checked ? 'ACTIVE' : 'INACTIVE' })} />开放题库</label>
      <Button size="small" disabled={!!draft} onClick={() => setEditing(course)}>显示范围</Button>
      {editing && <CourseEditorModal course={editing} onClose={() => setEditing(undefined)} onSaved={saved => { client.setQueryData(['subjects', saved.id], saved); setEditing(undefined) }} />}
      {draft && <div className="course-edit-actions" role="group" aria-label="课程修改">
        <Button size="small" type="text" loading={save.isPending} disabled={!draft.name.trim() || stale}
          onClick={() => save.mutate(draft)}>保存</Button>
        <Button className="course-edit-cancel" size="small" type="text" disabled={save.isPending} onClick={() => { setDraft(undefined); save.reset() }}>取消</Button>
      </div>}
    </div>
    {stale ? <p role="alert">课程已更新。请取消本次修改，核对最新信息后再保存。</p>
      : save.error ? <p role="alert">{save.error.message}</p>
      : !current.name.trim() ? <p role="alert">请输入课程名称。</p>
      : draft && draft.status !== course.status && <p role="status">{draft.status === 'INACTIVE'
        ? '保存后，学生端将隐藏这门课程下的题库。' : '保存后，已发布的题库将按原可见范围展示。'}</p>}
  </div>
}

export function QuestionBanksPage() {
  const gateway = useAdminGateway(), client = useQueryClient(), navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const courseId = params.get('course') || undefined
  const keyword = params.get('keyword') ?? ''
  const requestedPage = Number(params.get('page'))
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const requestedStatus = params.get('status') ?? ''
  const status = Object.prototype.hasOwnProperty.call(publicationLabels, requestedStatus) ? requestedStatus as BankPublicationStatus : undefined
  const qualityLabels = { missingExplanation: '题目缺解析', unassigned: '题目未分章', empty: '空题库' }
  const requestedQuality = params.get('quality') ?? ''
  const quality = Object.prototype.hasOwnProperty.call(qualityLabels, requestedQuality) ? requestedQuality as keyof typeof qualityLabels : undefined
  const setFilter = (key: string, value?: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'page') next.delete('page')
    setParams(next, { replace: key === 'keyword' })
  }
  const [courseSearch, setCourseSearch] = useState('')
  const [coursePage, setCoursePage] = useState(1)
  const courses = useQuery({ queryKey: ['subjects', 'list', coursePage, courseSearch], queryFn: () => gateway.listSubjects({ page: coursePage, pageSize: 20, keyword: courseSearch }) })
  const [creatingCourse, setCreatingCourse] = useState(false)
  const [bankEditor, setBankEditor] = useState<{ bank?: QuestionBank }>()
  const course = useQuery({ queryKey: ['subjects', courseId], enabled: Boolean(courseId), queryFn: () => gateway.getSubject(courseId!) })
  const banks = useQuery({ queryKey: ['question-banks', courseId, keyword, status, quality, page], queryFn: () => gateway.listQuestionBanks({ subjectId: courseId, keyword, publicationStatus: status, quality, page }) })
  const openBank = (id: string) => navigate('/question-banks/' + id + (quality === 'unassigned' ? '?chapter=unassigned' : ''), { state: { listSearch: params.toString() } })
  const bankAction = (key: string, bank: QuestionBank) => {
    if (key === 'delete') {
      Modal.confirm({
        title: '删除题库「' + bank.name + '」？',
        content: '删除后无法再用此题库开始新练习。学生已有的练习记录和统计会保留。',
        okText: '删除题库', cancelText: '取消', okButtonProps: { status: 'danger' },
        onOk: async () => {
          try {
            await gateway.deleteQuestionBank(bank.id, bank.version)
            if (page > 1 && banks.data?.items.length === 1) setFilter('page', String(page - 1))
            refreshWorkbench(client)
            Message.success('题库已删除')
          } catch (error) { Message.error((error as Error).message); throw error }
        },
      })
      return
    }
    Modal.confirm({ title: key === 'archive' ? '归档题库？' : '下架题库？', content: '「' + bank.name + '」将从学生列表中移除，保留已发放练习和历史记录。', okText: '确认', cancelText: '取消',
      onOk: async () => { try { await gateway.setBankPublication(bank.id, key === 'archive' ? 'ARCHIVED' : 'UNPUBLISHED', bank.version); refreshWorkbench(client) } catch (error) { Message.error((error as Error).message); throw error } } })
  }
  return <section className="bw-catalogue" aria-label="题库工作台">
    <aside className="bw-courses" aria-label="课程目录">
      <header><h2>课程目录</h2><Button type="text" icon={<IconPlus />} title="新建课程" aria-label="新建课程" onClick={() => setCreatingCourse(true)} /></header>
      <Input.Search aria-label="搜索课程" placeholder="搜课程" value={courseSearch} allowClear onChange={value => { setCourseSearch(value); setCoursePage(1) }} />
      <nav aria-label="选择课程">
        <button aria-pressed={!courseId} onClick={() => setFilter('course')}>全部课程</button>
        {courses.data?.items.map(subject => <button key={subject.id} aria-pressed={courseId === subject.id} onClick={() => {
          client.setQueryData(['subjects', subject.id], subject)
          setFilter('course', subject.id)
        }}><span>{subject.name}{subject.status === 'INACTIVE' && <small>已停用</small>}</span></button>)}
      </nav>
      {courses.data?.total === 0 && <p className="muted">{courseSearch ? '没有匹配的课程' : '暂无课程'}</p>}
      {courses.error && <ErrorState stale={!!courses.data} message={courses.error.message} onRetry={() => void courses.refetch()} />}
      {courses.data && courses.data.total > 20 && <Pagination simple size="small" current={coursePage} total={courses.data.total} pageSize={20} onChange={setCoursePage} />}
    </aside>
    <section className="bw-bank-panel" id="banks" aria-label="题库列表">
      <header className="bank-catalog-header">
        {courseId && course.data ? <CourseHeading key={courseId} course={course.data} /> : <h2>{courseId ? '课程题库' : '全部题库'}</h2>}
        <Button type="primary" icon={<IconPlus />} onClick={() => setBankEditor({})}>新建题库</Button>
      </header>
      {course.error && <ErrorState stale={!!course.data} message={course.error.message} onRetry={() => void course.refetch()} />}
      <div className="bank-catalog-filters">
        <div className="bw-status-filters" role="group" aria-label="发布状态">{(['ALL', 'DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED'] as const).map(value => <button key={value} className={(status ?? 'ALL') === value ? 'active' : ''} aria-pressed={(status ?? 'ALL') === value} onClick={() => { setFilter('status', value === 'ALL' ? undefined : value) }}>{value === 'ALL' ? '全部' : publicationLabels[value]}</button>)}</div>
        <div className="bw-list-toolbar"><Input.Search aria-label="搜索题库" placeholder="搜索题库名称" value={keyword} onChange={value => setFilter('keyword', value)} allowClear />
          <Select aria-label="按整理事项筛选题库" placeholder="整理事项" className="bw-quality-filter" value={quality} allowClear options={Object.entries(qualityLabels).map(([value, label]) => ({ value, label }))} onChange={value => setFilter('quality', value)} />
          <Button icon={<IconRefresh />} aria-label="刷新题库" loading={banks.isFetching} onClick={() => void banks.refetch()} /></div>
      </div>
      {banks.error && <ErrorState stale={!!banks.data} message={banks.error.message} onRetry={() => void banks.refetch()} />}
      <Table<QuestionBank> className="bw-bank-table" rowKey="id" data={banks.data?.items ?? []} loading={banks.isFetching} border={false} scroll={{ x: 620 }} pagination={{ current: page, pageSize: 20, total: banks.data?.total ?? 0, showTotal: true, onChange: value => setFilter('page', String(value)) }} columns={[
          { title: '题库 / 教材', render: (_, bank) => <button className="bw-bank-name" onClick={() => openBank(bank.id)}><span className="bw-bank-icon"><IconBook /></span><span><strong title={bank.name}>{bank.name}</strong>{bank.textbook && <small title={bank.textbook}>{bank.textbook}</small>}</span></button> },
          { title: '题数', dataIndex: 'questionCount', width: 80, align: 'right', render: count => <>{count}<span className="bank-count-unit"> 道题</span></> },
          { title: '状态', width: 100, render: (_, bank) => <Tag color={publicationColors[bank.publicationStatus]}>{publicationLabels[bank.publicationStatus]}</Tag> },
          { title: '操作', width: 112, render: (_, bank) => <Space size={0}><Button type="text" onClick={() => setBankEditor({ bank })}>设置</Button><Dropdown trigger="click" droplist={<Menu onClickMenuItem={key => bankAction(key, bank)}>{bank.publicationStatus === 'PUBLISHED' && <Menu.Item key="unpublish">下架</Menu.Item>}<Menu.Item key="archive">归档</Menu.Item><Menu.Item key="delete">删除题库</Menu.Item></Menu>}><Button type="text" aria-label={'更多操作 ' + bank.name} icon={<IconMore />} /></Dropdown></Space> },
        ]} noDataElement={<Empty description={banks.error ? '题库加载失败' : keyword || quality || status ? '没有符合条件的题库' : '暂无题库'} />} />
    </section>
    {creatingCourse && <CourseEditorModal onClose={() => setCreatingCourse(false)} onSaved={saved => { client.setQueryData(['subjects', saved.id], saved); setCreatingCourse(false); setFilter('course', saved.id) }} />}
    {bankEditor && <BankSettingsDrawer bank={bankEditor.bank} subjectId={courseId} onClose={() => setBankEditor(undefined)} onSaved={saved => { setBankEditor(undefined); if (!bankEditor.bank) openBank(saved.id) }} />}
  </section>
}
