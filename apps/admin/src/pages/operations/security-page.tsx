import { useState } from 'react'
import { Alert, Button, Card, Form, InputNumber, Modal, Switch } from '@arco-design/web-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { SecuritySettings } from '../../types/operations'

export function SecurityPage() {
  const gateway = useAdminGateway()
  const [editing, setEditing] = useState<SecuritySettings>()
  const query = useQuery({ queryKey: ['security'], queryFn: () => gateway.getSecuritySettings() })
  return <Card title="管理员登录与密码规则" extra={<Button disabled={!query.data} onClick={() => setEditing(query.data)}>编辑规则</Button>}>
    {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <p>登录失败锁定：{query.data?.lockEnabled ? '开启' : '关闭'}；失败次数 {query.data?.maxAttempts ?? '—'} 次，锁定 {query.data?.lockMinutes ?? '—'} 分钟。</p>
    <p>无操作自动退出：{query.data?.sessionMinutes ?? '—'} 分钟；密码至少 {query.data?.minPasswordLength ?? '—'} 位。</p>
    {editing && <SecurityEditor record={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void query.refetch() }} />}
  </Card>
}

function SecurityEditor({ record, onClose, onSaved }: { record: SecuritySettings; onClose: () => void; onSaved: () => void }) {
  const gateway = useAdminGateway(), [form] = Form.useForm<SecuritySettings>()
  const save = useMutation({ mutationFn: (input: SecuritySettings) => gateway.saveSecuritySettings({ ...input, version: record.version }), onSuccess: onSaved })
  return <Modal visible title="编辑安全规则" maskClosable={false} onCancel={() => { if (!save.isPending) onClose() }} onOk={() => form.submit()} confirmLoading={save.isPending} okText="保存" cancelText="取消">
    {save.error && <Alert type="error" content={save.error.message} />}<Form form={form} initialValues={record} layout="vertical" disabled={save.isPending} onSubmit={values => save.mutate(values)}>
      <Form.Item field="lockEnabled" label="失败锁定" triggerPropName="checked"><Switch /></Form.Item>
      {([['maxAttempts', '最大失败次数', 3, 10], ['lockMinutes', '锁定分钟数', 1, 1440], ['sessionMinutes', '无操作退出时间（分钟）', 5, 1440], ['minPasswordLength', '最短密码长度', 12, 64]] as const).map(([field, label, min, max]) => <Form.Item key={field} field={field} label={label} rules={[{ required: true }]}><InputNumber min={min} max={max} precision={0} /></Form.Item>)}
      {([['requireLetter', '必须有字母'], ['requireNumber', '必须有数字'], ['requireMixedCase', '必须有大小写']] as const).map(([field, label]) => <Form.Item key={field} field={field} label={label} triggerPropName="checked"><Switch /></Form.Item>)}
    </Form>
  </Modal>
}
