import { useState } from 'react'
import { Alert, Button, Drawer, Input, Table, Tag } from '@arco-design/web-react'
import { useQuery } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import { UserDetailDrawer } from '../../components/user-detail-drawer'
import { gradeLabel } from '../../types/admin'
import type { OnlineQuery, OnlineUser } from '../../types/monitoring'

export function OnlineUsersDrawer({ filters, visible, onClose }: { filters: OnlineQuery; visible: boolean; onClose: () => void }) {
  const gateway = useAdminGateway()
  const [page, setPage] = useState(1), [keyword, setKeyword] = useState(''), [userId, setUserId] = useState<string>()
  const online = useQuery({ queryKey: ['online-users', filters, page, keyword], queryFn: () => gateway.getOnlineUsers({ ...filters, page, pageSize: 20, keyword }), enabled: visible, refetchInterval: visible ? 30000 : false, refetchIntervalInBackground: false })
  return <Drawer title="当前在线账号" visible width="min(1100px, 95vw)" footer={null} onCancel={onClose}>
    <Input.Search aria-label="搜索在线账号或昵称" placeholder="账号或昵称" allowClear onSearch={value => { setKeyword(value); setPage(1) }} onClear={() => { setKeyword(''); setPage(1) }} />
    {online.error && <Alert type="warning" content="在线明细更新失败，已有数据已过期" action={<Button onClick={() => { void online.refetch() }}>重试</Button>} />}
    <p className="muted">采样时间：{online.data?.sampledAt ? new Date(online.data.sampledAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '等待数据'} · 沿用活跃度监控筛选 · 同一账号合并显示</p>
    <Table<OnlineUser> rowKey="userId" loading={online.isFetching} data={online.data?.items ?? []} scroll={{ x: 1080 }} pagination={{ current: page, pageSize: 20, total: online.data?.total ?? 0, onChange: setPage, showTotal: true }} columns={[
      { title: '昵称', width: 120, render: (_, row) => <Button type="text" onClick={() => setUserId(row.userId)}>{row.nickname}</Button> },
      { title: '账号', dataIndex: 'accountCode', width: 110 }, { title: '学院', dataIndex: 'collegeName', width: 130 }, { title: '专业', dataIndex: 'majorName', width: 130 },
      { title: '年级', width: 80, render: (_, row) => gradeLabel(row.currentGrade) }, { title: '登录设备数', dataIndex: 'onlineSessionCount', width: 90 },
      { title: '客户端', width: 230, render: (_, row) => row.clients.map(client => <Tag key={client.platform} title={'最近活跃：' + new Date(client.lastHeartbeatAt).toLocaleTimeString('zh-CN')}>小程序 · {client.sessionCount}</Tag>) },
      { title: '最近活跃', width: 170, render: (_, row) => new Date(row.lastHeartbeatAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) },
    ]} />
    {userId && <UserDetailDrawer id={userId} onClose={() => setUserId(undefined)} />}
  </Drawer>
}
