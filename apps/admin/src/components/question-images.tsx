import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Image, Space } from '@arco-design/web-react'
import { useAdminGateway } from '../gateways/gateway-context'

export function QuestionImages({ ids = [], bankId, onChange, disabled, onBusyChange, maxImages = 20 }: { ids?: string[]; bankId?: string; onChange?: (ids: string[]) => void; disabled?: boolean; onBusyChange?: (delta: number) => void; maxImages?: number }) {
  const gateway = useAdminGateway()
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const input = useRef<HTMLInputElement>(null)
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
  async function upload(file?: File) {
    if (!file || !bankId || !onChange || uploading) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { setError('请选择 5 MiB 以内的 PNG、JPEG 或 WebP 图片'); return }
    if (ids.length >= maxImages) { setError(`最多 ${maxImages} 张图片`); return }
    const epoch = generation.current
    setUploading(true); setError(''); onBusyChange?.(1)
    try { const image = await gateway.uploadImage(bankId, file); if (generation.current === epoch) onChange([...ids, image.id]) }
    catch (error) { if (generation.current === epoch) setError((error as Error).message) }
    finally { setUploading(false); onBusyChange?.(-1); if (input.current) input.current.value = '' }
  }
  return <Space direction="vertical" style={{ width: '100%' }}>
    {error && <Alert type="error" content={error} />}
    <Space wrap>{ids.map((id, index) => <Space direction="vertical" key={id}>
      {urls[id] ? <Image width={120} src={urls[id]} alt={`题目附件 ${index + 1}`} /> : <span>图片 {index + 1}</span>}
      {onChange && <Button size="mini" status="danger" disabled={disabled || uploading} onClick={() => onChange(ids.filter(value => value !== id))}>移除图片 {index + 1}</Button>}
    </Space>)}</Space>
    {onChange && <><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => void upload(event.target.files?.[0])} /><Button disabled={disabled || !bankId || ids.length >= maxImages} loading={uploading} onClick={() => input.current?.click()}>添加图片附件</Button></>}
  </Space>
}
