import { useState } from 'react'
import { ScopeEditor } from './scope-editor'
import { audienceGroups, groupsToCategories } from '../../lib/bank-workbench'
import { Alert, Form, Input, Message, Modal, Radio } from '@arco-design/web-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { ContentStatus, Subject } from '../../types/admin'
import { closeDraft, formHasChanges } from '../../lib/unsaved-changes'
import { refreshWorkbench } from './workbench-data'

export function CourseEditorModal({ course, onClose, onSaved }: {
  course?: Subject
  onClose: () => void
  onSaved: (course: Subject) => void
}) {
  const gateway = useAdminGateway()
  const client = useQueryClient()
  const [form] = Form.useForm<{ name: string; status: ContentStatus }>()
  const [initialGroups] = useState(() => audienceGroups(course?.categories ?? [], { colleges: [], majors: [] }))
  const [groups, setGroups] = useState(initialGroups)
  const initial = { name: course?.name ?? '', status: course?.status ?? 'ACTIVE' }
  const save = useMutation({
    mutationFn: (values: { name: string; status: ContentStatus }) => {
      const input = { ...values, categories: groupsToCategories(groups) }
      return course ? gateway.updateSubject(course.id, { ...input, description: course.description, expectedVersion: course.version }) : gateway.createSubject(input)
    },
    onError: error => Message.error(error.message),
    onSuccess: () => { refreshWorkbench(client); Message.success('课程已保存') },
  })
  const cancel = () => {
    closeDraft(!save.isPending && (formHasChanges(initial, form.getFieldsValue()) || JSON.stringify(groupsToCategories(groups)) !== JSON.stringify(groupsToCategories(initialGroups))), onClose)
  }
  return <Modal className="bw-course-editor" title={course ? "编辑课程" : "新建课程"} visible
    style={{ width: 640, maxWidth: 'calc(100vw - 32px)' }} onCancel={cancel} onOk={() => form.submit()}
    confirmLoading={save.isPending} okText="保存课程" cancelText="取消">
    {save.error && <Alert type="error" content={save.error.message} style={{ marginBottom: 20 }} />}
    <Form form={form} layout="vertical" disabled={save.isPending} initialValues={initial}
      onValuesChange={() => save.reset()} onSubmit={(values) => { if (!save.isPending) save.mutate(values, { onSuccess: onSaved }) }}>
      <Form.Item field="name" label="课程名称" rules={[{ required: true, message: '请输入课程名称' }]}>
        <Input autoFocus maxLength={120} placeholder="例如：数据结构" />
      </Form.Item>
      <Form.Item field="status" label="课程状态"><Radio.Group><Radio value="ACTIVE">启用</Radio><Radio value="INACTIVE">停用</Radio></Radio.Group></Form.Item>
      <ScopeEditor groups={groups} onChange={setGroups} disabled={save.isPending} />
      <p className="directory-form-note">同一门课程可以维护多份题库。课程停用后，其题库暂停在学生列表中展示，已有内容与记录保留。</p>
    </Form>
  </Modal>
}
