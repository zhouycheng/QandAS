import { useRef, useState } from 'react'
import { Alert, Button, Checkbox, Form, Message, Modal, Select, Table, Tag } from '@arco-design/web-react'
import { IconUpload } from '@arco-design/web-react/icon'
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
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false), [files, setFiles] = useState<File[]>([]), [preview, setPreview] = useState<ExcelPreview>(), [options, setOptions] = useState<ExcelOptions>({ targets: {} }), [busy, setBusy] = useState(false)
  const showIssueFiles = preview && (preview.files.length !== 1 || preview.issues.some(issue => issue.file !== preview.files[0].name))
  const chapters = useQueries({ queries: (preview?.files || []).map(f => ({ queryKey: ['excel-chapters', options.targets[f.fileId]?.bankId], enabled: !!options.targets[f.fileId]?.bankId, queryFn: () => gateway.listChapters(options.targets[f.fileId].bankId!) })) })
  const execute = async (work: () => Promise<void>) => { setBusy(true); try { await work() } catch (e) { Message.error((e as Error).message) } finally { setBusy(false) } }
  const check = async () => { const p = await gateway.previewExcel(resource, files, options); setPreview(p)
    setOptions(current => { const targets = { ...current.targets }; p.files.forEach(f => { if (targets[f.fileId]?.bankId && f.expectedContentVersion !== null) targets[f.fileId] = { ...targets[f.fileId], expectedContentVersion: f.expectedContentVersion } }); return { targets } })
  }
  const target = (id: string, patch: object) => { setPreview(current => current ? { ...current, valid: false, issues: [{ file: '批次', sheet: '映射', row: 1, column: '', message: '映射已调整，请重新预览' }] } : current); setOptions(current => ({ targets: { ...current.targets, [id]: { ...current.targets[id], ...patch } } })) }
  const cancel = () => { if (!busy) setOpen(false) }
  const importFiles = () => {
    if (!preview?.valid || busy) return
    void execute(async () => {
      await gateway.importExcel(resource, files, options)
      Message.success('导入完成'); setOpen(false); setPreview(undefined); setFiles([]); onImported()
    })
  }
  return <div className="excel-transfer">
    <Button loading={busy} onClick={() => void execute(async () => download(await gateway.downloadExcel(resource, 'template'), `${resource}-模板.xlsx`))}>下载 Excel 模板</Button>
    <Button onClick={() => setOpen(true)}>导入 Excel</Button>
    <Button loading={busy} onClick={() => Modal.confirm({ title: '导出 Excel', content: `导出当前筛选条件下的全部${count === undefined ? '' : ` ${count} 条`}记录。`, onOk: () => execute(async () => { const blob = await gateway.downloadExcel(resource, 'export', { ...query, bankId }); download(blob, blob.type.includes('zip') ? '题小搭-导出.zip' : `${resource}.xlsx`) }) })}>导出 Excel</Button>
    <Modal className="excel-import-modal" title={resource === 'users' ? '导入用户' : '导入题库'} visible={open}
      style={{ width: 900, maxWidth: 'calc(100vw - 32px)' }} maskClosable={false} closable={!busy} escToExit={!busy} onCancel={cancel} unmountOnExit
      footer={<div className="excel-import-footer">
        <span>{preview ? `本批 ${preview.count} 条 · ${preview.valid ? '校验通过' : '待处理提示'}` : files.length ? `已选择 ${files.length} 个文件` : '请选择导入文件'}</span>
        <div className="excel-import-actions">
          <Button disabled={busy} onClick={cancel}>取消</Button>
          <Button type={preview?.valid ? 'default' : 'primary'} disabled={!files.length || busy} loading={busy} onClick={() => void execute(check)}>预览并校验</Button>
          <Button type="primary" disabled={!preview?.valid || busy} loading={busy} onClick={importFiles}>确认导入{preview ? `（${preview.count} 条）` : ''}</Button>
        </div>
      </div>}>
      <div className="excel-import-content">
        <section className="excel-import-section">
          <div className="excel-import-section-heading"><h3>导入文件</h3><Button icon={<IconUpload />} disabled={busy} onClick={() => input.current?.click()}>{files.length ? '重新选择' : '选择文件'}</Button></div>
          <p className="excel-import-note">支持 Excel，或包含 Excel 和图片附件的 ZIP 压缩包；所选文件合计不超过 8 MiB。</p>
          <input ref={input} aria-label="选择 Excel 文件" type="file" accept=".xlsx,.zip,.png,.jpg,.jpeg,.webp" multiple hidden disabled={busy}
            onChange={e => { setFiles(Array.from(e.target.files || [])); setPreview(undefined); setOptions({ targets: {} }); e.target.value = '' }} />
          {!!files.length && !preview?.files.length && <ul className="excel-import-files">{files.map((file, index) => <li key={index}><span title={file.name}>{file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small></li>)}</ul>}
        </section>
        {preview?.files.map((f, index) => <section className="excel-import-file" key={f.fileId}>
          <div className="excel-import-section-heading"><h3 title={f.name}>{f.name}</h3><Tag>{f.count} 条</Tag></div>
          {f.types && <p className="excel-import-note">{Object.entries(f.types).map(([type, number]) => `${questionTypeLabels[type as QuestionType] || type} ${number}`).join(' · ')}</p>}
          {!!f.samples?.length && <><h4>账号预览（前 20 条）</h4><Table size="small" rowKey="email" data={f.samples} pagination={false} scroll={{ x: 640 }} columns={[{ title: '账号', dataIndex: 'accountCode' }, { title: '邮箱', dataIndex: 'email' }, { title: '昵称', dataIndex: 'nickname' }, { title: '状态', dataIndex: 'status' }, { title: '注册时间', dataIndex: 'registeredAt' }]} /></>}
          {resource === 'question-banks' && <Form layout="vertical" disabled={busy}>
            <div className="excel-import-targets">
              <Form.Item label="所属课程">
                <ResourceSelect kind="subject" placeholder={`按文件课程匹配：${f.subject}`} disabled={busy} value={options.targets[f.fileId]?.subjectId} onChange={id => target(f.fileId, { subjectId: String(id || '') || undefined })} />
                <Checkbox className="excel-import-create-course" disabled={busy} checked={options.targets[f.fileId]?.createSubject || false} onChange={value => target(f.fileId, { createSubject: value })}>课程不存在时创建“{f.subject}”</Checkbox>
              </Form.Item>
              <Form.Item label="目标题库" extra="留空时新建题库，选择已有题库则追加题目。">
                <ResourceSelect kind="bank" placeholder="新建题库" disabled={busy} value={options.targets[f.fileId]?.bankId} onChange={id => target(f.fileId, { bankId: String(id || '') || undefined, expectedContentVersion: undefined, chapterMap: {} })} />
              </Form.Item>
            </div>
            {options.targets[f.fileId]?.bankId && !!f.chapters?.length && <div className="excel-import-targets">
              {f.chapters.map(c => <Form.Item key={c.id} label={`章节：${c.name}`}><Select aria-label={`章节映射 ${c.name}`} placeholder="新建章节" disabled={busy} allowClear value={options.targets[f.fileId]?.chapterMap?.[c.id]} options={(chapters[index]?.data || []).map(item => ({ value: item.id, label: item.name }))} onChange={id => target(f.fileId, { chapterMap: { ...options.targets[f.fileId]?.chapterMap, [c.id]: id || undefined } })} /></Form.Item>)}
            </div>}
          </Form>}
        </section>)}
        {preview && <section className="excel-import-section">
          <div className="excel-import-section-heading"><h3>校验结果</h3>{!!preview.issues.length && <Button size="small" onClick={() => download(new Blob([JSON.stringify(preview.issues, null, 2)], { type: 'application/json' }), '导入核对清单.json')}>下载错误清单</Button>}</div>
          <Alert type={preview.valid ? 'success' : 'warning'} content={preview.valid ? `共 ${preview.count} 条记录，校验通过，可以确认导入。` : `发现 ${preview.issues.length} 项提示，请处理后重新预览。`} />
          {!!preview.issues.length && <Table className="excel-import-issues" size="small" rowKey={row => JSON.stringify(row)} data={preview.issues} border={false} scroll={{ x: 720 }} pagination={preview.issues.length > 10 ? { pageSize: 10, size: 'small' } : false} columns={[
            ...(showIssueFiles ? [{ title: '文件', dataIndex: 'file', width: 180, ellipsis: true }] : []),
            { title: '工作表', dataIndex: 'sheet', width: 100 },
            { title: '行', dataIndex: 'row', width: 50 },
            { title: '列', dataIndex: 'column', width: 120 },
            { title: '原因', dataIndex: 'message' },
          ]} />}
        </section>}
      </div>
    </Modal>
  </div>
}
