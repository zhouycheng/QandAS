import { useState } from 'react'
import { Alert, Button, Descriptions, Drawer, Form, Input, Message, Modal, Select, Space, Spin } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ResourceSelect } from './resource-select'
import { useAdminGateway } from '../gateways/gateway-context'
import { GRADE_OPTIONS, gradeLabel } from '../types/admin'
import type { UpdateManagedUserInput } from '../types/operations'
import { ErrorState } from './error-state'

interface UserProfileForm {
  nickname: string
  accountCode: string
  email: string
  collegeId?: string
  majorId?: string
  currentGrade?: number
}

export function UserDetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [form] = Form.useForm<UserProfileForm>()
  const [editing, setEditing] = useState(false), [dirty, setDirty] = useState(false), [collegeId, setCollegeId] = useState('')
  const user = useQuery({ queryKey: ['user', id], queryFn: () => gateway.getUser(id) })
  const stats = useQuery({ queryKey: ['user-statistics', id], queryFn: () => gateway.getUserStatistics(id) })
  const save = useMutation({
    mutationFn: (input: UpdateManagedUserInput) => gateway.updateUserProfile(id, input),
    onSuccess: () => {
      setEditing(false); setDirty(false); Message.success('学生资料已更新')
      for (const queryKey of [['user', id], ['users'], ['activity'], ['online-users'], ['organization-directory'], ['resource-label']]) {
        void client.invalidateQueries({ queryKey })
      }
    },
  })
  const confirmDiscard = (action: () => void) => {
    if (!dirty) return action()
    Modal.confirm({ title: '放弃未保存的修改？', content: '尚未保存的学生资料将丢失。', okText: '放弃修改', cancelText: '继续编辑', onOk: action })
  }
  const close = () => { if (!save.isPending) confirmDiscard(onClose) }
  const cancelEditing = () => { if (!save.isPending) confirmDiscard(() => { setEditing(false); setDirty(false) }) }
  const profile = user.data
  const profileFields = [
    { label: '昵称', value: profile?.name }, { label: '账号', value: profile?.account }, { label: '邮箱', value: profile?.email },
    { label: '微信绑定', value: profile?.wechatBound ? '已绑定' : '未绑定' },
    ...(profile?.avatarUrl ? [{ label: '头像', value: <img src={profile.avatarUrl} alt="账户头像" width={48} height={48} style={{ borderRadius: '50%' }} /> }] : []),
    { label: '学院', value: profile?.collegeName || '未填写' }, { label: '专业', value: profile?.majorName || '未填写' }, { label: '当前年级', value: gradeLabel(profile?.grade) },
  ]
  const statisticsFields = [
    { label: '已提交答题量', value: stats.data?.answeredCount ?? '—' }, { label: '正确题数', value: stats.data?.correctCount ?? '—' },
    { label: '学习时长', value: stats.data ? Math.floor(stats.data.durationSeconds / 60) + ' 分钟' : '—' },
  ]
  return <Drawer visible title="学生资料与学习摘要" width={560} maskClosable={!editing} onCancel={close}
    footer={editing ? <Space><Button disabled={save.isPending} onClick={cancelEditing}>取消</Button><Button type="primary" loading={save.isPending} onClick={() => form.submit()}>保存资料</Button></Space> : null}>
    {(user.error || stats.error) && <ErrorState message={(user.error || stats.error)!.message} onRetry={() => { void user.refetch(); void stats.refetch() }} />}
    <Spin loading={user.isPending || stats.isPending}>
      {profile && !editing && <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button onClick={() => { setCollegeId(profile.collegeId ?? ''); setDirty(false); save.reset(); setEditing(true) }}>编辑资料</Button>
      </div>}
      {editing && profile ? <>
        {save.error && <Alert type="error" content={save.error.message} />}
        <Alert className="section-gap" type="warning" content={profile.isTestAccount ? '测试账号的账号和邮箱由系统生成，登录凭据由管理员管理。' : '修改邮箱会使学生现有登录退出；清空邮箱后，学生无法再用邮箱密码登录。'} />
        <Form<UserProfileForm> form={form} layout="vertical" disabled={save.isPending}
          initialValues={{ nickname: profile.name, accountCode: profile.account, email: profile.email, collegeId: profile.collegeId ?? '', majorId: profile.majorId ?? '', currentGrade: profile.grade }}
          onValuesChange={(changed, values) => {
            setDirty(true); save.reset()
            if ('collegeId' in changed) {
              const nextCollegeId = values.collegeId ?? ''
              setCollegeId(nextCollegeId)
              if (nextCollegeId !== collegeId) form.setFieldsValue({ majorId: undefined })
            }
          }}
          onSubmit={values => {
            if (!profile) return
            save.mutate({ expectedVersion: profile.version, nickname: values.nickname, accountCode: values.accountCode, email: values.email.trim() || null,
              collegeId: values.collegeId || null, majorId: values.majorId || null, currentGrade: values.currentGrade ?? null })
          }}>
          <Form.Item field="nickname" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}><Input maxLength={40} /></Form.Item>
          <Form.Item field="accountCode" label="账号" rules={[{ required: true, message: '请输入账号' }]}><Input maxLength={12} disabled={profile.isTestAccount} /></Form.Item>
          <Form.Item field="email" label="邮箱"><Input type="email" disabled={profile.isTestAccount} maxLength={254} placeholder="留空表示未绑定邮箱" /></Form.Item>
          <Form.Item field="collegeId" label="学院"><ResourceSelect kind="college" placeholder="选择学院" /></Form.Item>
          <Form.Item field="majorId" label="专业"><ResourceSelect kind="major" collegeId={collegeId || undefined} disabled={!collegeId} placeholder="选择专业" /></Form.Item>
          <Form.Item field="currentGrade" label="当前年级"><Select options={GRADE_OPTIONS} placeholder="未填写" allowClear /></Form.Item>
        </Form>
      </> : <Descriptions column={1} data={profileFields} />}
      <Descriptions column={1} data={statisticsFields} />
    </Spin>
  </Drawer>
}
