import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Image, Message, Modal, Space } from '@arco-design/web-react'
import { IconCopy, IconDelete, IconPlus } from '@arco-design/web-react/icon'
import { useAdminGateway } from '../gateways/gateway-context'

export function QuestionImages({ ids = [], bankId, onChange, disabled, onBusyChange, maxImages = 20, inlineAlt, references = {}, onGalleryAdd, picker }: { ids?: string[]; bankId?: string; onChange?: (ids: string[]) => void; disabled?: boolean; onBusyChange?: (delta: number) => void; maxImages?: number; inlineAlt?: string; references?: Record<string,string[]>; onGalleryAdd?: () => void; picker?: React.RefObject<HTMLInputElement> }) {
  const gateway = useAdminGateway()
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [dragging, setDragging] = useState(false)
  const localPicker = useRef<HTMLInputElement>(null)
  const input = picker ?? localPicker
  const generation = useRef(0)
  const key = ids.join(',')
  useEffect(() => {
    const epoch = ++generation.current
    const created: string[] = []
    setUrls({}); setError('')
    ids.forEach(id => { void gateway.imageUrl(id).then(url => {
      if (generation.current !== epoch) { URL.revokeObjectURL(url); return }
      created.push(url); setUrls(previous => ({ ...previous, [id]: url }))
    }).catch(error => { if (generation.current === epoch) setError(error.message) }) })
    return () => { generation.current++; created.forEach(url => URL.revokeObjectURL(url)) }
  }, [gateway, key, bankId])
  async function upload(batch: File[]) {
    if (!batch.length || !bankId || !onChange || uploading || disabled) return
    if (batch.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) { setError('请选择 5 MiB 以内的 PNG、JPEG 或 WebP 图片'); return }
    if (ids.length + batch.length > maxImages) { setError(`最多 ${maxImages} 张图片`); return }
    const epoch = generation.current
    setUploading(true); setError(''); onBusyChange?.(1)
    const added: string[] = []
    try {
      for (const file of batch) {
        if (generation.current !== epoch) break
        added.push((await gateway.uploadImage(bankId, file)).id)
      }
    }
    catch (error) { if (generation.current === epoch) setError((error as Error).message) }
    finally { if (generation.current === epoch && added.length) onChange([...ids, ...added]); setUploading(false); onBusyChange?.(-1); if (input.current) input.current.value = '' }
  }
  if (inlineAlt !== undefined) {
    const src = urls[ids[0]]
    return src ? <span><button type="button" className="rich-image" onClick={() => setZoom(true)} aria-label={'放大' + inlineAlt}>
      <img src={src} alt={inlineAlt} /></button><Image.Preview src={src} visible={zoom} onVisibleChange={setZoom} /></span> : <span>{error || inlineAlt}</span>
  }
  if (!onChange) return <Space wrap>{error && <Alert type="error" content={error} />}{ids.map((id,index) => urls[id] ? <Image key={id} width={120} src={urls[id]} alt={`题目附件 ${index + 1}`} /> : <span key={id}>图片 {index + 1}</span>)}</Space>

  const cannotAdd = disabled || uploading || !bankId || ids.length >= maxImages
  async function copyLink(id: string, caption: string) {
    try {
      await navigator.clipboard.writeText('![' + caption.replace(/[\]\r\n]/g, ' ') + '](asset:' + id + ')')
      Message.success('图片引用已复制')
    } catch { Message.error('剪贴板不可用，请允许复制') }
  }
  return <div className="question-gallery">
    {error && <Alert type="error" content={error} />}
    <div className="question-gallery-strip">
      {ids.map((id, index) => {
        const caption = '图' + (index + 1)
        return <div className="question-gallery-item" key={id}>
          <div className="question-gallery-thumb">
            {urls[id] && <button type="button" className="question-gallery-copy" aria-label={'复制' + caption + '引用'} onClick={() => void copyLink(id, caption)}><img src={urls[id]} alt={caption} /></button>}
            <div className="question-gallery-actions">
              <Button size="small" icon={<IconCopy />} title="复制链接" aria-label={'复制链接 ' + (index + 1)} onClick={() => void copyLink(id, caption)} />
              <Button size="small" icon={<IconDelete />} status="danger" title="删除图片" aria-label={'删除图片 ' + (index + 1)} disabled={disabled || uploading} onClick={() => {
                if (references[id]?.length) { Message.warning('请先移除引用：' + references[id].join('、')); return }
                Modal.confirm({ title: '移除「' + caption + '」？', content: '保存题目后生效。', okText: '移除图片', cancelText: '保留', onOk: () => onChange(ids.filter(value => value !== id)) })
              }} />
            </div>
          </div>
        </div>
      })}
      <button type="button" className={'question-gallery-add' + (dragging ? ' dragging' : '')} disabled={cannotAdd} aria-label="添加图片" title="点击选图或拖入图片"
        onClick={() => { onGalleryAdd?.(); input.current?.click() }}
        onDragOver={event => { event.preventDefault(); event.stopPropagation(); setDragging(!cannotAdd) }}
        onDragLeave={() => setDragging(false)} onDrop={event => {
          event.preventDefault(); event.stopPropagation(); setDragging(false)
          onGalleryAdd?.(); void upload(Array.from(event.dataTransfer.files))
        }}><IconPlus /><span>{uploading ? '上传中…' : '添加图片'}</span></button>
    </div>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden multiple onChange={event => {
      const batch = Array.from(event.target.files ?? []); event.target.value = ''; void upload(batch)
    }} />
  </div>
}
