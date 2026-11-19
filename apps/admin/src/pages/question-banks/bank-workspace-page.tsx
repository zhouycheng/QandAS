import { downloadFile } from '../../lib/download-file'
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Dropdown, Input, Menu, Message, Modal, Select, Spin, Tag } from '@arco-design/web-react'
import { IconDown, IconDownload, IconEdit, IconExport, IconMore, IconPlus } from '@arco-design/web-react/icon'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import { publicationColors, publicationLabels } from '../../lib/recommendations'
import type { Chapter } from '../../types/admin'
import { BankSettingsDrawer } from './bank-settings-drawer'
import { ImportQuestionsModal } from './import-questions-modal'
import { PublicationModal } from './publication-modal'
import { QuestionsManager } from './questions-manager'
import { refreshWorkbench } from './workbench-data'
import { closeDraft } from '../../lib/unsaved-changes'

export function BankWorkspacePage() {
  const { id = '' } = useParams()
  const gateway = useAdminGateway()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const listSearch = useLocation().state?.listSearch
  const navigate = useNavigate()
  const chapterId = params.get('chapter') ?? undefined
  const [settings, setSettings] = useState<'basic' | 'scope'>()
  const [importing, setImporting] = useState<File | true | false>(false)
  const [exporting, setExporting] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [chapterEditor, setChapterEditor] = useState<Chapter | null | undefined>()
  const afterChapterCreated = useRef<((id: string) => void) | undefined>()
  const chapterTarget = useRef({ bankId: id, count: 0 })
  function newChapter(afterCreate?: (id: string) => void, bankId = id, count = chapters.data?.length ?? 0) {
    chapterTarget.current = { bankId, count }
    afterChapterCreated.current = afterCreate
    saveChapter.reset()
    setChapterName('')
    setChapterEditor(null)
  }
  const [chapterName, setChapterName] = useState('')
  const bankQuery = useQuery({ queryKey: ['bank-detail', id], queryFn: () => gateway.getQuestionBank(id) })
  const courseQuery = useQuery({ queryKey: ['subjects', bankQuery.data?.subjectId], enabled: Boolean(bankQuery.data), queryFn: () => gateway.getSubject(bankQuery.data!.subjectId) })
  const chapters = useQuery({ queryKey: ['chapters', id], queryFn: () => gateway.listChapters(id) })
  const refresh = () => refreshWorkbench(client)
  const saveChapter = useMutation({
    mutationFn: () => gateway.saveChapter(chapterEditor?.id, { name: chapterName, questionBankId: chapterEditor?.questionBankId ?? chapterTarget.current.bankId, sortOrder: chapterEditor?.sortOrder ?? chapterTarget.current.count, expectedVersion: chapterEditor?.version }),
    onSuccess: () => { refresh(); Message.success('章节已保存') },
    onError: error => Message.error(error.message),
  })
  const reorder = useMutation({ mutationFn: (ids: string[]) => gateway.reorderChapters(id, ids, bankQuery.data!.contentVersion), onSuccess: refresh, onError: (error) => Message.error(error.message) })
  const selectChapter = (value?: string) => setParams((previous) => { const next = new URLSearchParams(previous); next.delete('page'); if (value) next.set('chapter', value); else next.delete('chapter'); return next }, { state: { listSearch } })
  useEffect(() => {
    if (chapters.data && chapterId && chapterId !== 'unassigned' && !chapters.data.some((c) => c.id === chapterId)) selectChapter()
  }, [chapters.data, chapterId])
  const error = bankQuery.error ?? courseQuery.error ?? chapters.error
  if (error && (!bankQuery.data || !courseQuery.data || !chapters.data)) return <ErrorState message={error.message} onRetry={() => { void bankQuery.refetch(); void courseQuery.refetch(); void chapters.refetch() }} />
  if (bankQuery.isPending || courseQuery.isPending || chapters.isPending) return <div className="directory-loading"><Spin tip="正在加载题库内容" /></div>
  const bank = bankQuery.data!
  const course = courseQuery.data!
  const chapterRows = chapters.data ?? []
  const changePublication = (archive = false) => Modal.confirm({ title: archive ? '归档题库？' : '下架题库？', content: '「' + bank.name + '」将从学生列表中移除，保留原有题目与记录。', okText: '确认操作', cancelText: '取消',
    onOk: async () => { try { await gateway.setBankPublication(id, archive ? 'ARCHIVED' : 'UNPUBLISHED', bank.version); refresh(); Message.success('题库状态已更新') } catch (error) { Message.error((error as Error).message); throw error } } })
  const chapterAction = (key: string, chapter: Chapter, index: number) => {
    if (key === 'edit') { saveChapter.reset(); setChapterEditor(chapter); setChapterName(chapter.name); return }
    if (key === 'up' || key === 'down') {
      const ids = chapterRows.map((c) => c.id)
      const target = index + (key === 'up' ? -1 : 1)
      if (target < 0 || target >= ids.length) return
      ;[ids[index], ids[target]] = [ids[target], ids[index]]
      reorder.mutate(ids); return
    }
    let target: string | undefined
    Modal.confirm({ title: '删除章节「' + chapter.name + '」？', content: <label>将本章 {chapter.questionCount ?? 0} 道题移至<Select defaultValue="unassigned" options={[{value:'unassigned',label:'未分章'},...chapterRows.filter(c=>c.id!==chapter.id).map(c=>({value:c.id,label:c.name}))]} onChange={id => { target = id === 'unassigned' ? undefined : id }} /></label>, okText: '移动并删除章节', cancelText: '取消',
      onOk: async () => { try { await gateway.dissolveChapter(chapter, bank.contentVersion, target); if (chapterId === chapter.id) selectChapter(); refresh(); Message.success('章节已删除') } catch (error) { Message.error((error as Error).message); throw error } } })
  }
  return <section className="bw-catalogue bw-bank-detail" aria-label="题库内容工作台">
    <aside className="bw-courses" aria-label="章节目录">
      <header><h2>章节目录</h2><Button className="bank-rail-action" size="small" icon={<IconPlus />} onClick={() => newChapter()}>新建章节</Button></header>
      <nav aria-label="选择章节">
        <button aria-pressed={!chapterId} onClick={() => selectChapter()}><span>全部题目</span><small>{bank.questionCount}</small></button>
        <button aria-pressed={chapterId === 'unassigned'} onClick={() => selectChapter('unassigned')}><span>未分章</span><small>{Math.max(0, bank.questionCount - chapterRows.reduce((sum, c) => sum + (c.questionCount ?? 0), 0))}</small></button>
        {chapterRows.map((chapter, index) => <div className="bw-chapter-row" key={chapter.id}><button aria-pressed={chapterId === chapter.id} onClick={() => selectChapter(chapter.id)}><span>{chapter.name}</span><small>{chapter.questionCount ?? 0}</small></button>{chapterId === chapter.id && <Button size="mini" type="text" aria-label={`修改章名 ${chapter.name}`} title="修改章名" icon={<IconEdit />} onClick={() => chapterAction('edit', chapter, index)} />}<Dropdown trigger="click" droplist={<Menu onClickMenuItem={(key) => chapterAction(key, chapter, index)}><Menu.Item key="edit">编辑章节</Menu.Item><Menu.Item key="up" disabled={index === 0 || reorder.isPending}>上移章节</Menu.Item><Menu.Item key="down" disabled={index === chapterRows.length - 1 || reorder.isPending}>下移章节</Menu.Item><Menu.Item key="delete">删除章节</Menu.Item></Menu>}><Button size="mini" type="text" aria-label={`管理章节 ${chapter.name}`} icon={<IconMore />} /></Dropdown></div>)}
      </nav>
      <div className="bank-file-tools" role="group" aria-label="题包下载">
        <Button className="bank-rail-action" size="small" icon={<IconExport />} loading={exporting} onClick={async () => {
          setExporting(true)
          try { downloadFile(await gateway.exportBankPackage(id), bank.name + '.zip') }
          catch (error) { Message.error((error as Error).message) }
          finally { setExporting(false) }
        }}>导出 ZIP</Button>
        <Button className="bank-rail-action" size="small" icon={<IconDownload />} href="/qanda-bank-skills.zip" download="qanda-bank-skills.zip">下载 SKILL</Button>
      </div>
    </aside>
    <section className="bw-bank-panel" aria-label="题库题目">
      {error && <ErrorState stale message={error.message} onRetry={refresh} />}
      <header className="bw-detail-header">
        <div className="bw-detail-hero">
          <div className="bank-title"><h1>{bank.name}</h1><Tag color={publicationColors[bank.publicationStatus]}>{publicationLabels[bank.publicationStatus]}</Tag></div>
          <div className="bw-detail-actions">
            <Button.Group><Button onClick={() => setSettings('basic')}>题库设置</Button>
            {bank.publicationStatus !== 'ARCHIVED' && <Dropdown trigger="click" droplist={<Menu onClickMenuItem={() => changePublication(true)}><Menu.Item key="archive">归档题库</Menu.Item></Menu>}><Button icon={<IconDown />} aria-label="更多题库操作" /></Dropdown>}</Button.Group>
            {bank.publicationStatus === 'PUBLISHED' ? <Button status="warning" onClick={() => changePublication()}>下架题库</Button> : <Button type="outline" onClick={() => setPublishing(true)}>检查并发布</Button>}
          </div>
        </div>
        <div className="bw-detail-meta"><span>{course.name}</span>{bank.textbook && <span>{bank.textbook}</span>}
          {bank.activeQuestionCount != null && bank.activeQuestionCount < bank.questionCount && <span>{bank.activeQuestionCount} / {bank.questionCount} 道已启用</span>}
          {bank.categories.length > 0 && <button className="bw-detail-scope" onClick={() => setSettings('scope')}>{bank.categories.length} 组分类</button>}
        </div>
      </header>
      {course?.status !== 'ACTIVE' && <Alert className="bw-detail-alert" type="warning" content="所属课程已停用，题库暂不在学生列表中展示。请到课程目录恢复启用。" />}
      <QuestionsManager newChapter={newChapter} bank={bank} chapters={chapterRows} chapterId={chapterId} onImport={file => setImporting(file || true)} />
    </section>
    {settings && <BankSettingsDrawer bank={bank} initialTab={settings} onClose={() => setSettings(undefined)} onSaved={() => setSettings(undefined)} />}
    {importing && <ImportQuestionsModal initialFile={importing === true ? undefined : importing} bank={bank} chapters={chapterRows} onClose={() => setImporting(false)} onImported={refresh} />}
    {publishing && <PublicationModal bank={bank} onFix={target => {
      setPublishing(false)
      if (target === 'course') navigate('/question-banks?course=' + encodeURIComponent(bank.subjectId))
      else { setParams({ status: 'ACTIVE' }, { state: { listSearch } }); document.getElementById('bank-questions')?.scrollIntoView() }
    }} onClose={() => setPublishing(false)} />}
    <Modal className="bw-chapter-editor" title={chapterEditor ? '编辑章节' : '新建章节'} visible={chapterEditor !== undefined} style={{ width: 440, maxWidth: 'calc(100vw - 32px)' }} wrapStyle={{ zIndex: 1101 }} maskStyle={{ zIndex: 1100 }}
      confirmLoading={saveChapter.isPending} onOk={() => { if (!saveChapter.isPending) saveChapter.mutate(undefined, { onSuccess: chapter => {
        if (chapterEditor === null) afterChapterCreated.current?.(chapter.id)
        afterChapterCreated.current = undefined; setChapterEditor(undefined)
      } }) }}
      onCancel={() => closeDraft(!saveChapter.isPending && chapterName !== (chapterEditor?.name ?? ''), () => {
        saveChapter.reset(); afterChapterCreated.current = undefined; setChapterEditor(undefined)
      })}
      okText="保存章节" cancelText="取消">
      {saveChapter.error && <Alert type="error" className="bw-form-error" content={saveChapter.error.message} />}
      <label className="input-label">章节名称<Input placeholder="例如：第一章 函数与极限" value={chapterName} onChange={(value) => { setChapterName(value); saveChapter.reset() }} maxLength={60} disabled={saveChapter.isPending} /></label>
    </Modal>
  </section>
}
