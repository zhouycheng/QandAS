import { ManagementDrawer as Drawer } from '../../components/management-drawer'
import { useState } from 'react'
import { Alert, Button, Form, Input, Message, Space } from '@arco-design/web-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { QuestionBank } from '../../types/admin'
import { CourseEditorModal } from './course-editor-modal'
import { ResourceSelect } from '../../components/resource-select'
import { refreshWorkbench } from './workbench-data'
import { closeDraft, formHasChanges } from '../../lib/unsaved-changes'

export function BankSettingsDrawer({ bank, subjectId, onClose, onSaved }: {
  bank?: QuestionBank
  subjectId?: string
  onClose: () => void
  onSaved: (bank: QuestionBank) => void
}) {
  const gateway = useAdminGateway()
  const client = useQueryClient()
  const [form] = Form.useForm<{ subjectId: string; name: string; textbook: string; description: string }>()
  const [maintainerIds, setMaintainerIds] = useState(bank?.maintainerIds ?? [])
  const initial = { subjectId: bank?.subjectId ?? subjectId, name: bank?.name ?? '', textbook: bank?.textbook ?? '', description: bank?.description ?? '' }
  const [newCourse, setNewCourse] = useState(false)
  const save = useMutation({
    mutationFn: (values: { subjectId: string; name: string; textbook: string; description: string }) => {
      const input = {
        subjectId: values.subjectId ?? bank?.subjectId ?? subjectId ?? '',
        name: values.name ?? bank?.name ?? '',
        textbook: values.textbook ?? bank?.textbook ?? '',
        description: values.description ?? bank?.description ?? '',
        maintainerIds,
        status: bank?.status ?? 'ACTIVE' as const,
      }
      return bank ? gateway.updateQuestionBank(bank.id, { ...input, expectedVersion: bank.version }) : gateway.createQuestionBank(input)
    },
    onSuccess: () => { Message.success(bank ? '题库设置已保存' : '题库草稿已创建'); refreshWorkbench(client) },
    onError: (error) => Message.error(error.message),
  })
  const resetError = () => { if (save.isError) save.reset() }
  const cancel = () => {
    if (save.isPending) return onClose()
    closeDraft(formHasChanges(initial, form.getFieldsValue()) ||
      [...maintainerIds].sort().join(',') !== [...(bank?.maintainerIds ?? [])].sort().join(','), onClose)
  }
  return <>
    <Drawer className="bw-settings-drawer" width={680} style={{ maxWidth: '100vw' }} title={bank ? '题库设置' : '新建题库'} visible
      onCancel={cancel}
      footer={<Space><Button onClick={cancel}>取消</Button><Button type="primary" loading={save.isPending} onClick={() => form.submit()}>{bank ? '保存修改' : '创建草稿'}</Button></Space>}>
      {save.error && <Alert type="error" className="bw-form-error" content={save.error.message} />}
      <Form form={form} layout="vertical" disabled={save.isPending} initialValues={initial}
        onValuesChange={resetError} scrollToFirstError onSubmit={(values) => { if (!save.isPending) save.mutate(values, { onSuccess: onSaved }) }}>
            <Form.Item field="subjectId" label={<span>所属课程 {!bank && <Button size="mini" type="text" disabled={save.isPending} onClick={() => setNewCourse(true)}>新增课程</Button>}</span>} rules={[{ required: true, message: '请选择所属课程' }]}>
              <ResourceSelect kind="subject" placeholder="选择这份题库所属的课程" disabled={save.isPending || Boolean(bank)} />
            </Form.Item>
            <Form.Item field="name" label="题库名称" rules={[{ required: true, message: '请输入题库名称' }]}><Input placeholder="例如：同济版上册 · 章节练习" maxLength={80} /></Form.Item>
            <Form.Item field="textbook" label="教材 / 版本说明"><Input placeholder="例如：同济大学《高等数学》第七版上册" maxLength={120} /></Form.Item>
            <Form.Item field="description" label="题库说明（选填）"><Input.TextArea placeholder="说明内容范围、适用教材和复习建议，帮助学生选择" maxLength={2000} showWordLimit autoSize={{ minRows: 4, maxRows: 8 }} /></Form.Item>
            <Form.Item label="题库维护者"><ResourceSelect kind="admin" multiple placeholder="选择维护者" value={maintainerIds} onChange={value => { setMaintainerIds(value as string[]); resetError() }} /></Form.Item>
      </Form>
    </Drawer>
    {newCourse && <CourseEditorModal onClose={() => setNewCourse(false)} onSaved={(course) => { form.setFieldValue('subjectId', course.id); resetError(); setNewCourse(false) }} />}
  </>
}
