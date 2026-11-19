import { ManagementDrawer as Drawer } from './management-drawer'
import { useState } from 'react'
import { Alert, Button, Descriptions, Form, Input, Message, Space } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAdminGateway } from '../gateways/gateway-context'
import type { ManagedUser, UpdateManagedUserInput } from '../types/operations'
import { ErrorState } from './error-state'
import { closeDraft, formHasChanges } from '../lib/unsaved-changes'

interface UserProfileForm {
  nickname: string
  accountCode: string
  email: string
}

export function UserDetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [form] = Form.useForm<UserProfileForm>()
  const [editProfile, setEditProfile] = useState<ManagedUser>()
  const dirty = Boolean(editProfile)
  const user = useQuery({ queryKey: ['user', id], queryFn: () => gateway.getUser(id) })
  const stats = useQuery({ queryKey: ['user-statistics', id], queryFn: () => gateway.getUserStatistics(id) })
  const save = useMutation({
    mutationFn: (input: UpdateManagedUserInput) => gateway.updateUserProfile(id, input),
    onError: error => Message.error(error.message),
    onSuccess: async () => {
      await Promise.all([['user', id], ['users'], ['activity'], ['online-users'], ['organization-directory'], ['resource-label']].map(queryKey => client.invalidateQueries({ queryKey })))
      setEditProfile(undefined); Message.success('学生资料已更新')
    },
  })
  const close = () => closeDraft(dirty && !save.isPending, onClose)
  const cancelEditing = () => closeDraft(dirty, () => { form.resetFields(); setEditProfile(undefined); save.reset() })
  const profile = editProfile ?? user.data
  const initial = { nickname: profile?.name ?? '', accountCode: profile?.account ?? '', email: profile?.email ?? '' }
  const statisticsFields = [
    { label: '已提交答题量', value: stats.data?.answeredCount ?? '—' }, { label: '正确题数', value: stats.data?.correctCount ?? '—' },
    { label: '学习时长', value: stats.data ? Math.floor(stats.data.durationSeconds / 60) + ' 分钟' : '—' },
  ]
  return <Drawer visible title="学生资料与学习摘要" width={560} style={{ maxWidth: '100vw' }} onCancel={close}
    footer={dirty ? <Space><Button disabled={save.isPending} onClick={cancelEditing}>取消</Button><Button type="primary" loading={save.isPending} onClick={() => form.submit()}>保存资料</Button></Space> : null}>
    {user.error && <ErrorState stale={!!user.data} message={user.error.message} onRetry={() => void user.refetch()} />}
    {user.isPending && <p role="status">正在读取学生资料…</p>}
    {profile && <>
      <header className="user-identity">
        {profile.avatarUrl && <img src={profile.avatarUrl} alt="学生头像" width={44} height={44} />}
        <div><h2>{profile.name}</h2><small>{profile.wechatBound ? '已绑定微信' : '未绑定微信'}{profile.isTestAccount && ' · 测试账号'}</small></div>
      </header>
      {save.error && <Alert type="error" content={save.error.message} />}
        <Form<UserProfileForm> key={profile.version} form={form} layout="vertical" disabled={save.isPending}
          initialValues={initial}
          onValuesChange={(_, values) => { setEditProfile(formHasChanges(initial, values) ? profile : undefined); save.reset() }}
          onSubmit={values => {
            if (!profile) return
            save.mutate({ expectedVersion: profile.version, nickname: values.nickname, accountCode: values.accountCode, email: values.email.trim() || null })
          }}>
          <Form.Item field="nickname" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}><Input maxLength={40} /></Form.Item>
          <Form.Item field="accountCode" label="账号" rules={[{ required: true, message: '请输入账号' }]}><Input maxLength={12} disabled={profile.isTestAccount} /></Form.Item>
          <Form.Item field="email" label="邮箱" extra={profile.isTestAccount ? '测试账号由系统分配邮箱和账号。' : '修改邮箱会使现有登录退出，清空邮箱须已绑定微信。'}><Input type="email" disabled={profile.isTestAccount} maxLength={254} placeholder="留空表示未绑定邮箱" /></Form.Item>
        </Form>
    </>}
    <h3>学习摘要</h3>
    {stats.error && <ErrorState stale={!!stats.data} message={stats.error.message} onRetry={() => void stats.refetch()} />}
    <Descriptions column={1} data={statisticsFields} />
  </Drawer>
}
