import { useState } from 'react'
import { Alert, Button, Checkbox, Message, Modal, Select, Space, Table } from '@arco-design/web-react'
import { useQueries } from '@tanstack/react-query'
import { useAdminGateway } from '../gateways/gateway-context'
import { ResourceSelect } from './resource-select'
import { questionTypeLabels } from '../lib/labels'
import type { QuestionType } from '../types/admin'
import type { ExcelOptions, ExcelPreview } from '../types/excel'

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function ExcelTransfer({ resource, query = {}, count, bankId, onImported }: { resource: 'users' | 'question-banks'; query?: object; count?: number; bankId?: string; onImported: () => void }) {
  const gateway = useAdminGateway()
  const [open, setOpen] = useState(false), [files, setFiles] = useState<File[]>([]), [preview, setPreview] = useState<ExcelPreview>(), [options, setOptions] = useState<ExcelOptions>({ targets: {} }), [busy, setBusy] = useState(false)
  const chapters = useQueries({ queries: (preview?.files || []).map(f => ({ queryKey: ['excel-chapters', options.targets[f.fileId]?.bankId], enabled: !!options.targets[f.fileId]?.bankId, queryFn: () => gateway.listChapters(options.targets[f.fileId].bankId!) })) })
  const execute = async (work: () => Promise<void>) => { setBusy(true); try { await work() } catch (e) { Message.error((e as Error).message) } finally { setBusy(false) } }
  const check = async () => { const p = await gateway.previewExcel(resource, files, options); setPreview(p)
    setOptions(current => { const targets = { ...current.targets }; p.files.forEach(f => { if (targets[f.fileId]?.bankId && f.expectedContentVersion !== null) targets[f.fileId] = { ...targets[f.fileId], expectedContentVersion: f.expectedContentVersion } }); return { targets } })
  }
  const target = (id: string, patch: object) => { setPreview(current => current ? { ...current, valid: false, issues: [{ file: '批次', sheet: '映射', row: 1, column: '', message: '映射已调整，请重新预览' }] } : current); setOptions(current => ({ targets: { ...current.targets, [id]: { ...current.targets[id], ...patch } } })) }
  return <Space wrap>
    <Button loading={busy} onClick={() => void execute(async () => download(await gateway.downloadExcel(resource, 'template'), `${resource}-模板.xlsx`))}>下载 Excel 模板</Button>
    <Button onClick={() => setOpen(true)}>导入 Excel</Button>
    <Button loading={busy} onClick={() => Modal.confirm({ title: '导出 Excel', content: `导出当前筛选条件下的全部${count === undefined ? '' : ` ${count} 条`}记录。`, onOk: () => execute(async () => { const blob = await gateway.downloadExcel(resource, 'export', { ...query, bankId }); download(blob, blob.type.includes('zip') ? 'QandA-导出.zip' : `${resource}.xlsx`) }) })}>导出 Excel</Button>
    <Modal title={resource === 'users' ? '导入用户' : '导入题库'} visible={open} style={{ width: 900, maxWidth: '95vw' }} onCancel={() => !busy && setOpen(false)} footer={null} unmountOnExit>
      <Space direction="vertical" style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
        <Alert content="选择 Excel 或包含 Excel、图片附件的压缩包。先预览并处理提示，再确认导入。" />
        <input aria-label="选择 Excel 文件" type="file" accept=".xlsx,.zip,.png,.jpg,.jpeg,.webp" multiple disabled={busy} onChange={e => { setFiles(Array.from(e.target.files || [])); setPreview(undefined); setOptions({ targets: {} }) }} />
        <Button disabled={!files.length || busy} loading={busy} onClick={() => void execute(check)}>预览并校验</Button>
        {preview?.files.map((f, index) => <div key={f.fileId}><strong>{f.name} · {f.count} 条</strong>{f.types && <div>{Object.entries(f.types).map(([type, number]) => `${questionTypeLabels[type as QuestionType] || type} ${number}`).join(' · ')}</div>}{!!f.samples?.length && <><div>账号预览（前 20 条）</div><Table size="small" rowKey="email" data={f.samples} pagination={false} columns={[{ title: '账号', dataIndex: 'accountCode' }, { title: '邮箱', dataIndex: 'email' }, { title: '昵称', dataIndex: 'nickname' }, { title: '状态', dataIndex: 'status' }, { title: '注册时间', dataIndex: 'registeredAt' }]} /></>}{resource === 'question-banks' && <Space wrap>
          <ResourceSelect kind="subject" placeholder={`课程：${f.subject}`} value={options.targets[f.fileId]?.subjectId} onChange={id => target(f.fileId, { subjectId: String(id || '') || undefined })} />
          <Checkbox checked={options.targets[f.fileId]?.createSubject || false} onChange={value => target(f.fileId, { createSubject: value })}>课程不存在时创建“{f.subject}”</Checkbox>
          <ResourceSelect kind="bank" placeholder="选择追加题库（留空则创建）" value={options.targets[f.fileId]?.bankId} onChange={id => target(f.fileId, { bankId: String(id || '') || undefined, expectedContentVersion: undefined, chapterMap: {} })} />
          {options.targets[f.fileId]?.bankId && f.chapters?.map(c => <Select key={c.id} aria-label={`章节映射 ${c.name}`} placeholder={`${c.name}：新建章节`} allowClear value={options.targets[f.fileId]?.chapterMap?.[c.id]} options={(chapters[index]?.data || []).map(item => ({ value: item.id, label: item.name }))} onChange={id => target(f.fileId, { chapterMap: { ...options.targets[f.fileId]?.chapterMap, [c.id]: id || undefined } })} />)}
        </Space>}</div>)}
        {preview && <><Alert type={preview.valid ? 'success' : 'warning'} content={`本批 ${preview.count} 条，${preview.issues.length} 项提示。${preview.valid ? '可以确认导入。' : '请调整后重新预览。'}`} />
          {!!preview.issues.length && <><Button onClick={() => download(new Blob([JSON.stringify(preview.issues, null, 2)], { type: 'application/json' }), '导入核对清单.json')}>下载错误清单</Button><Table size="small" rowKey={row => JSON.stringify(row)} data={preview.issues} pagination={{ pageSize: 10 }} columns={['file', 'sheet', 'row', 'column', 'message'].map((key, i) => ({ title: ['文件', '工作表', '行', '列', '原因'][i], dataIndex: key }))} /></>}
          <Button type="primary" disabled={!preview.valid || busy} loading={busy} onClick={() => void execute(async () => { await gateway.importExcel(resource, files, options); Message.success('导入完成'); setOpen(false); setPreview(undefined); setFiles([]); onImported() })}>确认导入 {preview.count} 条</Button></>}
      </Space>
    </Modal>
  </Space>
}
