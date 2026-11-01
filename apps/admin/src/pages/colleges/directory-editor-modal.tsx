import { useState } from 'react'
import { Alert, Form, Input, Message, Modal, Radio } from '@arco-design/web-react'
import { useMutation } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { College, ContentStatus, Major } from '../../types/admin'

export type DirectoryEntry =
  | { kind: 'college'; record: College }
  | { kind: 'major'; record: Major }

export type EditorTarget =
  | { kind: 'college'; record?: College }
  | { kind: 'major'; college: College; record?: Major }

const labels = { college: '学院', major: '专业' }

interface EditorValues {
  name: string
  code: string
  status: ContentStatus
}

export function DirectoryEditorModal({ target, onCancel, onSaved }: {
  target: EditorTarget
  onCancel: () => void
  onSaved: () => void
}) {
  const gateway = useAdminGateway()
  const [form] = Form.useForm<EditorValues>()
  const [dirty, setDirty] = useState(false)
  const label = labels[target.kind]
  const save = useMutation({
    mutationFn: async (values: EditorValues) => {
      if (target.kind === 'college') {
        const input = { name: values.name, code: values.code, status: values.status }
        return target.record ? gateway.updateCollege(target.record.id, { ...input, expectedVersion: target.record.version }) : gateway.createCollege(input)
      }
      if (target.kind === 'major') {
        const input = { name: values.name, code: values.code, status: values.status, collegeId: target.college.id }
        return target.record ? gateway.updateMajor(target.record.id, { ...input, expectedVersion: target.record.version }) : gateway.createMajor(input)
      }
    },
    onSuccess: () => {
      Message.success(`${label}已${target.record ? '更新' : '新增'}`)
      onSaved()
    },
  })
  const cancel = () => {
    if (save.isPending) return
    if (!dirty) return onCancel()
    Modal.confirm({
      title: '放弃本次修改？',
      content: '尚未保存的内容将丢失。',
      okText: '放弃修改', cancelText: '继续编辑', onOk: onCancel,
    })
  }
  return (
    <Modal
      className="directory-editor"
      title={`${target.record ? '编辑' : '新增'}${label}`}
      visible
      style={{ width: 480, maxWidth: 'calc(100vw - 32px)' }}
      maskClosable={false}
      escToExit={!save.isPending}
      closable={!save.isPending}
      confirmLoading={save.isPending}
      cancelButtonProps={{ disabled: save.isPending }}
      okText={target.record ? '保存修改' : `新增${label}`}
      cancelText="取消"
      onCancel={cancel}
      onOk={() => form.submit()}
    >
      {save.error && <Alert className="directory-form-error" type="error" content={save.error.message} />}
      <Form<EditorValues>
        form={form}
        layout="vertical"
        initialValues={{ ...target.record, status: target.record?.status ?? 'ACTIVE' }}
        onValuesChange={() => { setDirty(true); save.reset() }}
        onSubmit={(values) => { if (!save.isPending) save.mutate(values) }}
        disabled={save.isPending}
      >
        {target.kind !== 'college' && <Form.Item label="所属学院"><Input value={target.college.name} disabled /></Form.Item>}
        <>
          <Form.Item field="name" label={`${label}名称`} rules={[{ required: true, message: `请输入${label}名称` }]}>
            <Input autoFocus placeholder={target.kind === 'college' ? '例如：信息学院' : '例如：计算机科学与技术'} maxLength={60} />
          </Form.Item>
          <Form.Item field="code" label={`${label}代码`} rules={[{ required: true, message: `请输入${label}代码` }]}>
            <Input placeholder={target.kind === 'college' ? '例如：INFO' : '例如：CS'} maxLength={24} />
          </Form.Item>
        </>
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
