import { useState } from 'react'
import { Button, Card, Message } from '@arco-design/web-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'

export function CommunityGroupPreview() {
  const gateway = useAdminGateway()
  const query = useQuery({ queryKey: ['community-group'], queryFn: () => gateway.getCommunityGroup(), staleTime: 0 })
  if (query.error) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
  return query.data?.available && query.data.expiresAt && Date.parse(query.data.expiresAt) > Date.now()
    ? <img src={gateway.communityGroupImage(query.data.version)} alt="QandA 用户交流群二维码" style={{ display: 'block', maxWidth: '100%', maxHeight: 480, margin: '16px auto' }} />
    : <p>{query.isFetching ? '正在读取群二维码…' : '群二维码更新中，请稍后再试'}</p>
}

export function CommunityGroupPage() {
  const gateway = useAdminGateway()
  const query = useQuery({ queryKey: ['community-group'], queryFn: () => gateway.getCommunityGroup() })
  const [image, setImage] = useState('')
  const [expires, setExpires] = useState('')
  const save = useMutation({
    mutationFn: () => gateway.saveCommunityGroup({ expectedVersion: query.data!.version, image, expiresAt: new Date(expires).toISOString() }),
    onSuccess: async () => { setImage(''); setExpires(''); await query.refetch(); Message.success('群二维码已更新') },
    onError: error => Message.error(error.message)
  })
  const selectImage = (file?: File) => {
    if (!file) return
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) { Message.error('请选择不超过 5 MiB 的 PNG 或 JPEG 图片'); return }
    const reader = new FileReader()
    reader.onload = () => setImage(String(reader.result))
    reader.onerror = () => Message.error('图片读取失败，请重试')
    reader.readAsDataURL(file)
  }
  const valid = !!query.data && !!image && !!expires && Number.isFinite(Date.parse(expires)) && Date.parse(expires) > Date.now()
  return <Card>
    {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <p>当前状态：{query.data ? query.data.available ? '有效' : query.data.expiresAt ? '已过期' : '未设置' : '读取中'}</p>
    {query.data?.expiresAt && <p>有效期至：{new Date(query.data.expiresAt).toLocaleString()}</p>}
    {(image || query.data?.available) && <img src={image || gateway.communityGroupImage(query.data!.version)} alt="群二维码" style={{ display: 'block', maxWidth: 260, maxHeight: 380, objectFit: 'contain', marginBottom: 16 }} />}
    <p><label>选择群二维码 <input type="file" accept="image/png,image/jpeg" onChange={event => selectImage(event.target.files?.[0])} /></label></p>
    <p><label>有效期至 <input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} /></label></p>
    <p className="muted">请根据微信生成的群码填写有效期，过期后小程序将提示更新。</p>
    <Button type="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>保存二维码</Button>
  </Card>
}
