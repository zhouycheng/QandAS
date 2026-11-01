import { useState } from 'react'
import { Button, Dropdown, Empty, Input, Menu, Message, Modal, Pagination, Space, Table, Tag } from '@arco-design/web-react'
import { IconBook, IconMore, IconPlus, IconRefresh } from '@arco-design/web-react/icon'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import { getAdminSession } from '../../lib/auth'
import { publicationColors, publicationLabels } from '../../lib/recommendations'
import type { BankPublicationStatus, QuestionBank, Subject } from '../../types/admin'
import { BankSettingsDrawer } from './bank-settings-drawer'
import { CourseEditorModal } from './course-editor-modal'
import { CourseAccessDrawer } from './course-access-drawer'
import { refreshWorkbench } from './workbench-data'

export function QuestionBanksPage() {
  const gateway = useAdminGateway(), client = useQueryClient(), navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const courseId = params.get('course') || undefined
  const platform = getAdminSession()?.role === 'PLATFORM_ADMIN'
  const [courseSearch, setCourseSearch] = useState(''), [keyword, setKeyword] = useState('')
  const [coursePage, setCoursePage] = useState(1), [page, setPage] = useState(1)
  const [status, setStatus] = useState<BankPublicationStatus>()
  const [courseEditor, setCourseEditor] = useState<Subject | null>()
  const [access, setAccess] = useState<Subject>()
  const [bankEditor, setBankEditor] = useState<{ bank?: QuestionBank; tab: 'basic' | 'scope' }>()
  const courses = useQuery({ queryKey: ['subjects', 'list', coursePage, courseSearch], queryFn: () => gateway.listSubjects({ page: coursePage, keyword: courseSearch }) })
  const course = useQuery({ queryKey: ['subjects', courseId], enabled: Boolean(courseId), queryFn: () => gateway.getSubject(courseId!) })
  const banks = useQuery({ queryKey: ['question-banks', courseId, keyword, status, page], queryFn: () => gateway.listQuestionBanks({ subjectId: courseId, keyword, publicationStatus: status, page }) })
  const selectCourse = (id?: string) => { setParams(id ? { course: id } : {}); setPage(1); setKeyword(''); setStatus(undefined) }
  const bankAction = (key: string, bank: QuestionBank) => {
    if (key === 'basic' || key === 'scope') { setBankEditor({ bank, tab: key }); return }
    Modal.confirm({ title: key === 'archive' ? '归档题库？' : '下架题库？', content: '从学生列表中移除，保留已发放练习和历史记录。', okText: '确认', cancelText: '取消',
      onOk: async () => { try { await gateway.setBankPublication(bank.id, key === 'archive' ? 'ARCHIVED' : 'UNPUBLISHED', bank.version); refreshWorkbench(client) } catch (error) { Message.error((error as Error).message); throw error } } })
  }
  return <section className="bw-page" aria-label="题库工作台">
    <div className="bw-catalogue">
      <aside className="bw-courses">
        <div className="bw-section-heading"><h2>课程目录</h2>{platform && <Button type="text" icon={<IconPlus />} aria-label="新建课程" onClick={() => setCourseEditor(null)} />}</div>
        <Input.Search aria-label="搜索课程" placeholder="搜索课程名称" value={courseSearch} onChange={value => { setCourseSearch(value); setCoursePage(1) }} allowClear />
        <button className={`bw-course-choice ${!courseId ? 'active' : ''}`} onClick={() => selectCourse()}>全部课程</button>
        {courses.error && <ErrorState message={courses.error.message} onRetry={() => void courses.refetch()} />}
        {courses.data?.items.map(subject => <div className={`bw-course-row ${courseId === subject.id ? 'active' : ''}`} key={subject.id}>
          <button className="bw-course-choice" onClick={() => selectCourse(subject.id)}><IconBook /><span>{subject.name}{subject.status === 'INACTIVE' && <em>已停用</em>}</span></button>
          {platform && <Dropdown trigger="click" droplist={<Menu onClickMenuItem={key => key === 'access' ? setAccess(subject) : setCourseEditor(subject)}><Menu.Item key="edit">编辑 / 停用课程</Menu.Item><Menu.Item key="access">单独开放用户</Menu.Item></Menu>}><Button type="text" size="mini" icon={<IconMore />} aria-label={'管理课程 ' + subject.name} /></Dropdown>}
        </div>)}
        <Pagination simple size="small" current={coursePage} total={courses.data?.total ?? 0} pageSize={20} onChange={setCoursePage} />
      </aside>
      <div className="bw-bank-panel">
        <div className="bw-panel-heading"><h2>{course.data?.name ?? '全部题库'}</h2>{platform && <Button type="primary" icon={<IconPlus />} onClick={() => setBankEditor({ tab: 'basic' })}>新建题库</Button>}</div>
        {course.error && <ErrorState message={course.error.message} onRetry={() => void course.refetch()} />}
        <div className="bw-status-filters">{(['ALL', 'DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED'] as const).map(value => <button key={value} className={(status ?? 'ALL') === value ? 'active' : ''} aria-pressed={(status ?? 'ALL') === value} onClick={() => { setStatus(value === 'ALL' ? undefined : value); setPage(1) }}>{value === 'ALL' ? '全部' : publicationLabels[value]}</button>)}</div>
        <div className="bw-list-toolbar"><Input.Search aria-label="搜索题库" placeholder="搜索题库名称" value={keyword} onChange={value => { setKeyword(value); setPage(1) }} allowClear /><Button icon={<IconRefresh />} aria-label="刷新题库" loading={banks.isFetching} onClick={() => void banks.refetch()} /></div>
        {banks.error && <ErrorState message={banks.error.message} onRetry={() => void banks.refetch()} />}
        <Table<QuestionBank> className="bw-bank-table" rowKey="id" data={banks.data?.items ?? []} loading={banks.isFetching} border={false} scroll={{ x: 800 }} pagination={{ current: page, pageSize: 20, total: banks.data?.total ?? 0, showTotal: true, onChange: setPage }} columns={[
          { title: '题库 / 教材', width: 300, render: (_, bank) => <button className="bw-bank-name" onClick={() => navigate('/question-banks/' + bank.id)}><span className="bw-bank-icon"><IconBook /></span><span><strong>{bank.name}</strong><small>{bank.textbook || '教材说明待补充'}</small></span></button> },
          { title: '适用范围', render: (_, bank) => bank.scopeType === 'ALL' ? '全校开放' : bank.audiences.length ? bank.audiences.length + ' 组资料条件' : '待设置' },
          { title: '题数', dataIndex: 'questionCount' },
          { title: '状态', render: (_, bank) => <Tag color={publicationColors[bank.publicationStatus]}>{publicationLabels[bank.publicationStatus]}</Tag> },
          { title: '操作', width: 180, render: (_, bank) => <Space size={0}><Button type="text" onClick={() => navigate('/question-banks/' + bank.id)}>管理题目</Button><Dropdown trigger="click" droplist={<Menu onClickMenuItem={key => bankAction(key, bank)}><Menu.Item key="basic">基本信息</Menu.Item><Menu.Item key="scope">展示范围</Menu.Item>{bank.publicationStatus === 'PUBLISHED' && <Menu.Item key="unpublish">下架</Menu.Item>}<Menu.Item key="archive">归档</Menu.Item></Menu>}><Button type="text" aria-label={'更多操作 ' + bank.name} icon={<IconMore />} /></Dropdown></Space> },
        ]} noDataElement={<Empty description="暂无符合条件的题库" />} />
      </div>
    </div>
    {courseEditor !== undefined && <CourseEditorModal course={courseEditor ?? undefined} onClose={() => setCourseEditor(undefined)} onSaved={() => { setCourseEditor(undefined); refreshWorkbench(client) }} />}
    {bankEditor && <BankSettingsDrawer bank={bankEditor.bank} subjectId={courseId} initialTab={bankEditor.tab} onClose={() => setBankEditor(undefined)} onSaved={() => setBankEditor(undefined)} />}
    {access && <CourseAccessDrawer subject={access} onClose={() => setAccess(undefined)} />}
  </section>
}
