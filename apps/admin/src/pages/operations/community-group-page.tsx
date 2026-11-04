import { useState } from 'react'
import { Button, Card, DatePicker, Message } from '@arco-design/web-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import { communityGroupDate, communityGroupExpiryAt, defaultCommunityGroupExpiry } from '../../lib/community-group-expiry'

export function CommunityGroupPreview() {
  const gateway = useAdminGateway()
  const query = useQuery({ queryKey: ['community-group'], queryFn: () => gateway.getCommunityGroup(), staleTime: 0 })
  if (query.error) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
  return query.data?.available && query.data.expiresAt && Date.parse(query.data.expiresAt) > Date.now()
    ? <img src={gateway.communityGroupImage(query.data.version)} alt="题小搭用户交流群二维码" style={{ display: 'block', maxWidth: '100%', maxHeight: 480, margin: '16px auto' }} />
    : <p>{query.isFetching ? '正在读取群二维码…' : '群二维码更新中，请稍后再试'}</p>
}

export function CommunityGroupPage() {
  const gateway = useAdminGateway()
  const query = useQuery({ queryKey: ['community-group'], queryFn: () => gateway.getCommunityGroup() })
  const [image, setImage] = useState('')
  const [expires, setExpires] = useState(() => defaultCommunityGroupExpiry())
  const expiresAt = communityGroupExpiryAt(expires)
  const save = useMutation({
    mutationFn: () => gateway.saveCommunityGroup({ expectedVersion: query.data!.version, image, expiresAt: expiresAt! }),
    onSuccess: async () => { setImage(''); setExpires(defaultCommunityGroupExpiry()); await query.refetch(); Message.success('群二维码已更新') },
    onError: error => Message.error(error.message)
  })
  const selectImage = (file?: File) => {
    if (!file) return
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) { Message.error('请选择不超过 5 MiB 的 PNG 或 JPEG 图片'); return }
    const reader = new FileReader()
    reader.onload = () => { setImage(String(reader.result)); setExpires(defaultCommunityGroupExpiry()) }
    reader.onerror = () => Message.error('图片读取失败，请重试')
    reader.readAsDataURL(file)
  }
  const valid = !!query.data && !!image && !!expiresAt && Date.parse(expiresAt) > Date.now()
  return <Card>
    {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <p>当前状态：{query.data ? query.data.available ? '有效' : query.data.expiresAt ? '已过期' : '未设置' : '读取中'}</p>
    {query.data?.expiresAt && <p>有效期至：{communityGroupDate(new Date(query.data.expiresAt))}</p>}
    {(image || query.data?.available) && <img src={image || gateway.communityGroupImage(query.data!.version)} alt="群二维码" style={{ display: 'block', maxWidth: 260, maxHeight: 380, objectFit: 'contain', marginBottom: 16 }} />}
    <p><label>选择群二维码 <input type="file" accept="image/png,image/jpeg" disabled={save.isPending} onChange={event => selectImage(event.target.files?.[0])} /></label></p>
    <p><label htmlFor="community-group-expiry">有效期至 </label><DatePicker inputProps={{ id: 'community-group-expiry' }} value={expires} onChange={setExpires} disabled={save.isPending} style={{ width: 180 }} /></p>
    <p className="muted">选择图片后默认填入 7 天后的日期，可按群码标注调整；有效期按北京时间所选日期结束计算，实际以微信群码为准。</p>
    <Button type="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>保存二维码</Button>
  </Card>
}
