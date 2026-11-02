import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Message,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Table,
  Tag,
} from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconArrowDown, IconArrowUp, IconClose, IconMinus, IconPlus, IconUpload } from '@arco-design/web-react/icon'
import { useAdminGateway } from '../../gateways/gateway-context'
import { matchImportChapters, prepareImportIntent, type ImportIntent } from '../../lib/import-intent'
import { refreshWorkbench } from './workbench-data'
import { mapImportFile, parseImportFile, type ParsedQuestionFile, type PortableQuestion, type QuestionBankFile } from '../../lib/question-bank-file'
import { QuestionImages } from '../../components/question-images'
import { questionTypeLabels } from '../../lib/labels'
import { answerSummary, countQuestions } from '../../lib/question-content'
import templateUrl from '../../../../../docs/question-bank-import/template.json?url'
import exampleUrl from '../../../../../docs/question-bank-import/examples/six-types.json?url'
import codeUrl from '../../../../../docs/question-bank-import/examples/code-content.json?url'
import schemaUrl from '../../../../../docs/question-bank-import/schema.json?url'
import { QuestionContentView } from '../questions/question-content-view'
import type { QuestionBank } from '../../types/admin'
interface ImportFile extends ParsedQuestionFile {
  id: string
  name: string
  progress: number
  bytes: number
  chapterMap: Record<string, string>
  assetMap: Record<string, string>
  error?: string
}
export function ImportQuestionsModal({
  bank,
  onClose,
  defaultChapterId,
  onCreateChapter,
}: {
  bank: QuestionBank
  onClose: () => void
  defaultChapterId?: string
  onCreateChapter: (name: string) => void
}) {
  const gateway = useAdminGateway()
  const client = useQueryClient()
  const chapters = useQuery({ queryKey: ['chapters', bank.id], queryFn: () => gateway.listChapters(bank.id) })
  const [chapterId, setChapterId] = useState(defaultChapterId)
  const input = useRef<HTMLInputElement>(null)
  const intent = useRef<ImportIntent>()
  const generation = useRef(0)
  const [files, setFiles] = useState<ImportFile[]>([])
  const [previewId, setPreviewId] = useState<string>()
  const [previewStage, setPreviewStage] = useState<'answer' | 'feedback' | 'review'>('review')
  const preview = files.find(file => file.id === previewId)
  const [uploads, setUploads] = useState(0)
  const [dragging, setDragging] = useState(false)
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  const addFiles = async (incoming: FileList | File[]) => {
    if (files.length + incoming.length > 20) {
      Message.error('一次最多选择 20 个文件')
      return
    }
    if (files.reduce((sum, file) => sum + file.bytes, 0) + Array.from(incoming).reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) { Message.error('每批 JSON 文件合计最多 8 MiB'); return }
    const token = generation.current
    const next = Array.from(incoming).map((file) => ({ file, id: crypto.randomUUID() }))
    setFiles((current) => [
      ...current,
      ...next.map(({ file, id }) => ({ id, name: file.name, bytes: file.size, progress: 0, questions: [], chapterMap: {}, assetMap: {} })),
    ])
    for (const { file, id } of next) {
      try {
        if (!file.name.toLowerCase().endsWith('.json')) throw new Error('仅支持 JSON 文件')
        if (file.size > 8 * 1024 * 1024) throw new Error('每批请求最多 8 MiB')
        if (token !== generation.current) return
        setFiles((current) => current.map((f) => (f.id === id ? { ...f, progress: 40 } : f)))
        const parsed = parseImportFile(await file.text(), bank.id)
        const chapterMap = matchImportChapters(parsed, chapters.data ?? [])
        if (token === generation.current)
          setFiles((current) => current.map((f) => (f.id === id ? { ...f, ...parsed, chapterMap, progress: 100 } : f)))
      } catch (e) {
        if (token === generation.current)
          setFiles((current) =>
            current.map((f) =>
              f.id === id
                ? { ...f, progress: 100, error: e instanceof Error ? e.message : '无法识别文件' }
                : f,
            ),
          )
      }
    }
  }
  const save = useMutation({
    mutationFn: async () => {
      intent.current = prepareImportIntent(files, bank.id, bank.contentVersion, chapterId, intent.current)
      const current = intent.current
      if (!current.previewed) { await gateway.previewImport(current.input); current.previewed = true }
      return gateway.importQuestions(current.input)
    },
    onSuccess: (count) => {
      refreshWorkbench(client)
      Message.success(`已导入 ${count} 道题`)
      onClose()
    },
    onError: (e) => Message.error(e.message),
  })
  const total = files.reduce((sum, f) => sum + countQuestions(f.questions), 0)
  const mappingError = files.map(file => { try { mapImportFile(file, file.chapterMap, file.assetMap, chapterId); return '' } catch (error) { return `${file.name} · ${(error as Error).message}` } }).find(Boolean)
  const ready =
    !chapters.isError &&
    !chapters.isLoading &&
    files.length > 0 &&
    files.every((f) => f.progress === 100 && !f.error) &&
    total <= 3000 && !mappingError && uploads === 0
  const updateFile = (id: string, patch: Partial<ImportFile>) => setFiles(current => current.map(file => file.id === id ? { ...file, ...patch, chapterMap: { ...file.chapterMap, ...patch.chapterMap }, assetMap: { ...file.assetMap, ...patch.assetMap } } : file))
  const move = (id: string, direction: number) =>
    setFiles((current) => {
      const next = [...current]
      const index = next.findIndex((f) => f.id === id)
      const target = index + direction
      if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]]
      return next
    })
  const cancel = () => {
    if (save.isPending || uploads) return
    if (!files.length) return onClose()
    Modal.confirm({ title: '放弃本次导入预览？', content: '已选择的文件与预览结果将清空。', okText: '放弃导入', cancelText: '继续检查', onOk: onClose })
  }
  return (
    <>
      <Modal
        className="bw-import-modal"
        title="批量导入题目文件"
        visible
        style={{ width: 940, maxWidth: 'calc(100vw - 32px)' }}
        onCancel={cancel}
        onOk={() => { if (ready && !save.isPending) save.mutate() }}
        okText={`确认导入${total ? `（${total} 道题）` : ''}`}
        okButtonProps={{ disabled: !ready }}
        confirmLoading={save.isPending}
        cancelButtonProps={{ disabled: save.isPending }}
        maskClosable={false}
        escToExit={!save.isPending}
        closable={!save.isPending}
      >
        <p>导入到：{bank.name}</p>
        {save.error && <Alert className="bw-form-error" type="error" content={save.error.message} action={<Button onClick={() => { void client.invalidateQueries({ queryKey: ['bank-detail', bank.id] }); void chapters.refetch() }}>刷新题库信息</Button>} />}
        <Space wrap style={{ marginBottom: 16 }}><a href={templateUrl} download="qanda-template.json">下载空白模板</a><a href={exampleUrl} download="qanda-six-types.json">下载六类题型示例</a><a href={codeUrl} download="qanda-code-content.json">下载代码题示例</a><a href={schemaUrl} download="qanda-schema.json">下载 JSON Schema</a></Space>
        {chapters.isError && (
          <Alert
            type="error"
            content={chapters.error.message}
            action={
              <Button type="text" onClick={() => void chapters.refetch()}>
                重试章节加载
              </Button>
            }
          />
        )}
        <div className="input-label">
          <span>归入章节</span>
          <Select
            aria-label="导入归入章节"
            allowClear
            placeholder="按文件章节，无章节则归入未分章"
            value={chapterId}
            onChange={setChapterId}
            disabled={save.isPending}
          >
            {chapters.data?.map((c) => (
              <Select.Option key={c.id} value={c.id}>
                {c.name}
              </Select.Option>
            ))}
          </Select>
        </div>
        <div
          className={`upload-zone ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (!save.isPending) void addFiles(e.dataTransfer.files)
          }}
        >
          <IconUpload />
          <p>拖拽多个 JSON 文件到此处，或点击批量选择</p>
          <Button onClick={() => input.current?.click()} disabled={save.isPending}>
            选择 JSON 文件
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept=".json,application/json"
            aria-label="选择 JSON 文件"
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <small className="muted">每次最多导入 3000 道题、20 个 JSON 文件，文件合计不超过 8 MiB；阅读理解按小题计数</small>
        </div>
        <h3>文件识别进度</h3>
        <Table
          rowKey="id"
          data={files}
          pagination={false}
          scroll={{ y: 300, x: 750 }}
          noDataElement={<p className="empty-note">请选择题目文件</p>}
          columns={[
            { title: '文件名称', dataIndex: 'name', width: 200 },
            { title: '题目数量', width: 90, render: (_, f) => `${countQuestions(f.questions)} 道题` },
            {
              title: '识别进度',
              width: 160,
              render: (_, f) => (
                <Progress percent={f.progress} status={f.error ? 'error' : 'success'} size="small" />
              ),
            },
            {
              title: '状态',
              width: 170,
              render: (_, f) =>
                f.error ? (
                  <span className="error-text" role="alert">
                    {f.error}
                  </span>
                ) : (
                  <Tag color={f.progress === 100 ? 'green' : 'arcoblue'}>
                    {f.progress === 100 ? '识别完成' : '识别中'}
                  </Tag>
                ),
            },
            {
              title: '操作',
              width: 210,
              render: (_, f, i) => (
                <Space size="mini">
                  <Button type="text" disabled={!f.questions.length} onClick={() => setPreviewId(f.id)}>
                    预览
                  </Button>
                  <Button
                    type="text"
                    aria-label={`上移 ${f.name}`}
                    icon={<IconArrowUp />}
                    disabled={i === 0 || save.isPending}
                    onClick={() => move(f.id, -1)}
                  />
                  <Button
                    type="text"
                    aria-label={`下移 ${f.name}`}
                    icon={<IconArrowDown />}
                    disabled={i === files.length - 1 || save.isPending}
                    onClick={() => move(f.id, 1)}
                  />
                  <Button
                    type="text"
                    aria-label={`移除 ${f.name}`}
                    icon={<IconClose />}
                    disabled={save.isPending || uploads > 0}
                    onClick={() => setFiles((current) => current.filter((v) => v.id !== f.id))}
                  />
                </Space>
              ),
            },
          ]}
        />
        {files.filter(file => file.document).map(file => <section key={file.id} className="import-example">
          <h3>{file.name} · 选择章节与图片</h3>
          <p className="muted">文件题库：{file.document!.bank.name}。本次内容写入上方选择的目标题库。</p>
          {!chapterId && file.document!.chapters.map(chapter => <div className="input-label" key={chapter.id}>
            <span>{chapter.name}（{chapter.id}）</span><Space style={{ width: '100%' }}>
              <Select style={{ minWidth: 250 }} aria-label={`${file.name} 章节 ${chapter.id}`} placeholder="选择目标章节" value={file.chapterMap[chapter.id]} disabled={save.isPending}
                onChange={value => updateFile(file.id, { chapterMap: { ...file.chapterMap, [chapter.id]: value } })}
                options={(chapters.data ?? []).map(value => ({ label: value.name, value: value.id }))} />
              <Button disabled={save.isPending} onClick={() => onCreateChapter(chapter.name)}>新建此章节</Button>
            </Space>
          </div>)}
          {file.document!.assets.map(asset => <section key={asset.id} aria-label={`附件映射 ${file.name} ${asset.id}`}>
            <p>{asset.path}（{asset.id}）</p><QuestionImages bankId={bank.id} maxImages={1} ids={file.assetMap[asset.id] ? [file.assetMap[asset.id]] : []} disabled={save.isPending}
              onBusyChange={delta => setUploads(count => count + delta)} onChange={ids => updateFile(file.id, { assetMap: { ...file.assetMap, [asset.id]: ids[0] ?? '' } })} />
          </section>)}
        </section>)}
        {mappingError && <Alert type="warning" content={mappingError} style={{ marginTop: 16 }} />}
        <Alert
          style={{ marginTop: 20 }}
          type={total > 3000 ? 'error' : 'info'}
          content={
            total > 3000
              ? '题目总量超过 3000，请移除部分文件。'
              : '文件识别完成后可预览并确认导入。上下箭头可调整顺序；导入失败时文件会保留，可直接重试。'
          }
        />
      </Modal>
      <Modal
        title={`文件预览：${preview?.name ?? ''}`}
        visible={Boolean(preview)}
        onCancel={() => setPreviewId(undefined)}
        footer={null}
        style={{ width: 760, maxWidth: 'calc(100vw - 32px)' }}
      >
        <p className="muted">共 {countQuestions(preview?.questions ?? [])} 道题，{preview?.questions.length ?? 0} 条记录。展开记录可查看完整题干、阅读材料和答案。</p>
        {preview?.document && <><p>{preview.document.bank.description}</p><h3>来源清单</h3><ul>{preview.document.sources.map(source => <li key={source.id}>{source.name} · {source.kind}{source.uri ? ` · ${source.uri}` : ''}</li>)}</ul></>}
        <Radio.Group value={previewStage} onChange={setPreviewStage} options={[{ label: '学生作答', value: 'answer' }, { label: '即时反馈', value: 'feedback' }, { label: '交卷复盘', value: 'review' }]} style={{ marginBottom: 16 }} />
        <Table
          rowKey="previewId"
          data={preview ? mapImportFile(preview, preview.chapterMap, preview.assetMap, chapterId, true).map((q, i) => ({ ...q, previewId: i })) : []}
          pagination={{ pageSize: 5, showTotal: true }}
          scroll={{ x: 650 }}
          expandedRowRender={(question) => <><QuestionContentView question={question} stage={previewStage} />{preview?.document && <ImportProvenance question={preview.document.questions[question.previewId]} document={preview.document} />}</>}
          expandProps={{ icon: ({ expanded, record }) => <button type="button" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}题目内容 ${record.stem}`}>{expanded ? <IconMinus /> : <IconPlus />}</button> }}
          columns={[
            {
              title: '题型',
              dataIndex: 'type',
              render: (v) => questionTypeLabels[v as keyof typeof questionTypeLabels],
            },
            { title: '题干', dataIndex: 'stem' },
            { title: '答案 / 小题', render: (_, question) => answerSummary(question) },
          ]}
        />
      </Modal>
    </>
  )
}

function ImportProvenance({ question, document }: { question: PortableQuestion; document: QuestionBankFile }) {
  const provenance = question.provenance
  return <section><h4>{question.id} · {provenance.origin === 'extracted' ? '原题提取' : '依据材料编题'}</h4>
    <ul>{provenance.sourceRefs.map((ref, index) => <li key={index}>{document.sources.find(source => source.id === ref.sourceId)?.name} · {ref.location}</li>)}</ul>
    <p>AI 辅助整理的内容：{provenance.ai.fields.join('、') || '无'}</p><p>{provenance.ai.note}</p>
    {!!question.assetIds && <p>原文件图片引用：{(question.assetIds as string[]).join('、')}</p>}
    {question.subQuestions?.map(sub => <ImportProvenance key={sub.id} question={sub} document={document} />)}
  </section>
}
