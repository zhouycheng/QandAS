import { useState } from 'react'
import { Button, Card, DatePicker, Form, Message, Tag, Upload } from '@arco-design/web-react'
import { IconUpload } from '@arco-design/web-react/icon'
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
    if (!file || save.isPending) return
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) { Message.error('请选择不超过 5 MiB 的 PNG 或 JPEG 图片'); return }
    const reader = new FileReader()
    reader.onload = () => { setImage(String(reader.result)); setExpires(defaultCommunityGroupExpiry()) }
    reader.onerror = () => Message.error('图片读取失败，请重试')
    reader.readAsDataURL(file)
  }
  const valid = !!query.data && !!image && !!expiresAt && Date.parse(expiresAt) > Date.now()
  return <Card className="community-group-card">
    {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <div className="community-group-layout">
      <Upload className="community-group-upload" drag autoUpload={false} showUploadList={false} fileList={[]} accept={{ type: 'image/png,image/jpeg', strict: false }} disabled={save.isPending}
        beforeUpload={file => { selectImage(file); return false }}>
        <div className="community-group-dropzone" role="button" tabIndex={save.isPending ? -1 : 0} aria-label="点击选择或拖入群二维码" aria-disabled={save.isPending}>
          {(image || query.data?.available) ? <img src={image || gateway.communityGroupImage(query.data!.version)} alt={image ? '待保存的群二维码' : '当前群二维码'} /> : <IconUpload />}
          <strong>{image || query.data?.available ? '点击或拖拽替换二维码' : '拖拽群二维码到这里'}</strong>
          <span>也可以点击选择图片</span>
          <small>PNG / JPEG，最大 5 MiB</small>
        </div>
      </Upload>
      <Form className="community-group-form" layout="vertical">
        <div className="community-group-status"><span>当前状态</span><Tag color={query.data?.available ? 'green' : 'gray'}>{query.data ? query.data.available ? '有效' : query.data.expiresAt ? '已过期' : '未设置' : '读取中'}</Tag>{image && <Tag color="orange">待保存</Tag>}</div>
        {query.data?.expiresAt && <p className="community-group-current-expiry">当前二维码有效期至 {communityGroupDate(new Date(query.data.expiresAt))}</p>}
        <Form.Item label="有效期至" extra="按北京时间所选日期结束时到期。">
          <DatePicker inputProps={{ id: 'community-group-expiry' }} value={expires} onChange={setExpires} disabled={save.isPending} style={{ width: '100%' }} />
        </Form.Item>
        <p className="community-group-note">选择图片后默认有效期为 7 天，请按微信群码标注的日期调整。</p>
        <Button type="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>保存二维码</Button>
      </Form>
    </div>
  </Card>
}
