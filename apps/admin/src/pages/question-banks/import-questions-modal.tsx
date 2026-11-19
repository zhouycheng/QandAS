import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Upload, Message, Modal, Select, Space, Table } from '@arco-design/web-react'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { Chapter, QuestionBank } from '../../types/admin'
import type { PackageResult } from '../../types/bank-package'
import { closeDraft } from '../../lib/unsaved-changes'

export function ImportQuestionsModal({ bank, chapters, initialFile, onClose, onImported }: {
  initialFile?: File; bank: QuestionBank; chapters: Chapter[]; onClose: () => void; onImported: () => void
}) {
  const gateway = useAdminGateway()
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState('')
  const [upload, setUpload] = useState('')
  const [preview, setPreview] = useState<PackageResult>()
  const [filename, setFilename] = useState('')
  const [progress, setProgress] = useState(0)
  const started = useRef(false)
  const dismissed = useRef(false)
  useEffect(() => {
    if (initialFile && !started.current) { started.current = true; void check(initialFile) }
  }, [initialFile])
  const [key, setKey] = useState('')
  const [chapterMap, setChapterMap] = useState<Record<string, string>>({})
  const [ambiguous, setAmbiguous] = useState('')
  async function check(file?: File, mappings = chapterMap) {
    setBusy(true); setError(''); setPreview(undefined); setAmbiguous('')
    try {
      let id = upload
      if (file) {
        setFilename(file.name); setProgress(0); setUpload(''); setChapterMap({}); mappings = {}
        if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('请选择 ZIP 题包')
        id = await gateway.uploadBankPackage(bank.id, file, setProgress); setUpload(id)
      }
      const result = await gateway.previewBankPackage(bank.id, { uploadId: id, chapterMap: mappings })
      setPreview(result); setKey(crypto.randomUUID())
    } catch (e) {
      const message = (e as Error).message
      setError(message)
      const match = /\[chapter:([^\]]+)\]/.exec(message)
      if (match) setAmbiguous(match[1])
    } finally { setBusy(false) }
  }
  const updates = preview?.changes.some(c => c.action === 'UPDATE')
  const added = preview?.changes.filter(c => c.action === 'CREATE').length ?? 0
  const unchanged = preview && !added && !updates && !preview.newChapters.length
  async function commit() {
    if (!preview || busy) return
    if (unchanged) { onClose(); return }
    setCommitting(true); setBusy(true); setError('')
    try {
      await gateway.commitBankPackage(bank.id, { uploadId: upload, chapterMap, digest: preview.digest, expectedContentVersion: preview.contentVersion, confirmUpdates: Boolean(updates) }, key)
      onImported(); Message.success('题包已导入')
      if (!dismissed.current) onClose()
    } catch (e) { setError((e as Error).message); if (dismissed.current) Message.error((e as Error).message) } finally { setBusy(false); setCommitting(false) }
  }
  return <Modal className="bank-import-review" style={{ width: 760, maxWidth: 'calc(100vw - 24px)' }} title={'导入 ZIP · ' + bank.name} visible
    onCancel={() => closeDraft(!committing && !unchanged && (Boolean(upload) || busy), () => { dismissed.current = true; onClose() }, '关闭后，已选题包和章节映射将清除。')}
    onOk={commit} okText={unchanged ? '完成' : updates ? '确认更新并导入' : added ? '导入 ' + added + ' 道题' : '确认导入'}
    okButtonProps={{ disabled: !preview, loading: busy }}>
    <Space direction="vertical" style={{ width: '100%' }}>
      <Upload drag accept=".zip" disabled={busy} autoUpload={false} showUploadList={false} beforeUpload={file => { void check(file); return false }}>
        <div className="bank-package-drop"><strong>{filename || '拖入 ZIP 题包'}</strong><span>{busy ? progress < 100 ? '已上传 ' + progress + '%' : '正在处理题包…' : '点击选择文件'}</span></div>
      </Upload>
      {error && <Alert type="error" content={error} />}
      {ambiguous && <Select placeholder="选择目标章节" options={chapters.map(c => ({ value: c.id, label: c.name }))} onChange={id => {
        const next = { ...chapterMap, [ambiguous]: id }; setChapterMap(next); void check(undefined, next)
      }} />}
      {error && upload && <Button disabled={busy} onClick={() => void check()}>重新预览</Button>}
      {preview && <>
        <strong>{unchanged ? '题库已是最新' : '新增 ' + added + ' · 更新 ' + preview.changes.filter(c => c.action === 'UPDATE').length + ' · 跳过 ' + preview.changes.filter(c => c.action === 'SKIP').length}</strong>
        {preview.newChapters.length > 0 && <p>将新增章节：{preview.newChapters.join('、')}</p>}
        {updates && <Table rowKey="portableId" data={preview.changes.filter(c => c.action === 'UPDATE')} pagination={{ pageSize: 10 }} columns={[
          { title: '题号', dataIndex: 'portableId' },
          { title: '操作', render: (_, row) => ({ CREATE: '新增', UPDATE: '更新', SKIP: '跳过' })[row.action as 'CREATE'|'UPDATE'|'SKIP'] },
          { title: '修改内容', render: (_, row) => row.fields.map((field: string) => <details open key={field}><summary>{field}</summary>
            <div>原值<pre>{JSON.stringify(row.differences[field][0], null, 2)}</pre></div>
            <div>新值<pre>{JSON.stringify(row.differences[field][1], null, 2)}</pre></div></details>) },
        ]} />}
      </>}
    </Space>
  </Modal>
}
