import { useState } from 'react'
import { Alert, Form, Input, Message, Modal, Radio } from '@arco-design/web-react'
import { useMutation } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { College, ContentStatus, Major } from '../../types/admin'
import { closeDraft, formHasChanges } from '../../lib/unsaved-changes'

export type DirectoryEntry =
  | { kind: 'college'; record: College }
  | { kind: 'major'; record: Major }

export type EditorTarget =
  | { kind: 'college'; record?: College }
  | { kind: 'major'; college: College; record?: Major }

const labels = { college: '学院', major: '专业' }

interface EditorValues {
  name: string
  status: ContentStatus
}

export function DirectoryEditorModal({ target, onCancel, onSaved }: {
  target: EditorTarget
  onCancel: () => void
  onSaved: () => void
}) {
  const gateway = useAdminGateway()
  const [form] = Form.useForm<EditorValues>()
  const initial = { name: target.record?.name ?? '', status: target.record?.status ?? 'ACTIVE' }
  const [generatedCode] = useState(() => `${target.kind === 'college' ? 'COL' : 'MAJ'}-${crypto.randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`)
  const label = labels[target.kind]
  const save = useMutation({
    mutationFn: async (values: EditorValues) => {
      if (target.kind === 'college') {
        const input = { name: values.name, code: target.record?.code ?? generatedCode, status: values.status }
        return target.record ? gateway.updateCollege(target.record.id, { ...input, expectedVersion: target.record.version }) : gateway.createCollege(input)
      }
      if (target.kind === 'major') {
        const input = { name: values.name, code: target.record?.code ?? generatedCode, status: values.status, collegeId: target.college.id }
        return target.record ? gateway.updateMajor(target.record.id, { ...input, expectedVersion: target.record.version }) : gateway.createMajor(input)
      }
    },
    onError: error => Message.error(error.message),
    onSuccess: () => {
      Message.success(`${label}已${target.record ? '更新' : '新增'}`)
      onSaved()
    },
  })
  const cancel = () => {
    closeDraft(!save.isPending && formHasChanges(initial, form.getFieldsValue()), onCancel)
  }
  return (
    <Modal
      className="directory-editor"
      title={`${target.record ? '编辑' : '新增'}${label}`}
      visible
      style={{ width: 480, maxWidth: 'calc(100vw - 32px)' }}
      confirmLoading={save.isPending}
      okText={target.record ? '保存修改' : `新增${label}`}
      cancelText="取消"
      onCancel={cancel}
      onOk={() => form.submit()}
    >
      {save.error && <Alert className="directory-form-error" type="error" content={save.error.message} />}
      <Form<EditorValues>
        form={form}
        layout="vertical"
        initialValues={initial}
        onValuesChange={() => save.reset()}
        onSubmit={(values) => { if (!save.isPending) save.mutate(values, { onSuccess: onCancel }) }}
        disabled={save.isPending}
      >
        {target.kind !== 'college' && <Form.Item label="所属学院"><Input value={target.college.name} disabled /></Form.Item>}
        <Form.Item field="name" label={`${label}名称`} rules={[{ required: true, message: `请输入${label}名称` }]}>
          <Input autoFocus placeholder={target.kind === 'college' ? '例如：信息学院' : '例如：计算机科学与技术'} maxLength={60} />
        </Form.Item>
        <Form.Item field="status" label="学生可选状态">
          <Radio.Group>
            <Radio value="ACTIVE">启用</Radio>
            <Radio value="INACTIVE">停用</Radio>
          </Radio.Group>
        </Form.Item>
        <p className="directory-form-note">停用后不再供学生新选择，已有学生的归属与学习记录保留。上级停用时，下级也暂停供学生新选择。</p>
      </Form>
    </Modal>
  )
}
