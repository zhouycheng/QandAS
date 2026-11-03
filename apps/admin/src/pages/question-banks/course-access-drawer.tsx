import { useState } from 'react'
import { Alert, Button, Drawer, Message, Space, Table } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ResourceSelect } from '../../components/resource-select'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { Subject } from '../../types/admin'
import { refreshWorkbench } from './workbench-data'

export function CourseAccessDrawer({ subject, onClose }: { subject: Subject; onClose: () => void }) {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [page, setPage] = useState(1), [userId, setUserId] = useState<string>()
  const course = useQuery({ queryKey: ['subjects', subject.id], queryFn: () => gateway.getSubject(subject.id), initialData: subject })
  const query = useQuery({ queryKey: ['subject-access', subject.id, page], queryFn: () => gateway.listSubjectAccess(subject.id, { page }) })
  const save = useMutation({ mutationFn: ({ id, remove }: { id: string; remove: boolean }) => remove ? gateway.revokeSubjectAccess(subject.id, id, course.data.version) : gateway.grantSubjectAccess(subject.id, id, course.data.version), onSuccess: () => { setUserId(undefined); refreshWorkbench(client); Message.success('课程开放名单已更新') } })
  return <Drawer visible title={subject.name + ' · 单独开放'} width={680} onCancel={onClose} footer={null}>
    <p>向指定学生开放整门课程，包含以后新增的已发布题库。学生可继续自由修改个人资料。</p>
    {(query.error || course.error || save.error) && <Alert type="error" content={(query.error || course.error || save.error)?.message} action={<Button onClick={() => { void query.refetch(); void course.refetch(); save.reset() }}>刷新重试</Button>} />}
    <Space className="list-toolbar list-toolbar-separated" wrap><ResourceSelect kind="user" placeholder="选择学生账号" value={userId} onChange={value => setUserId(String(value || ''))} /><Button type="primary" disabled={!userId} loading={save.isPending} onClick={() => save.mutate({ id: userId!, remove: false })}>添加</Button></Space>
    <Table scroll={{ x: 660 }} rowKey="userId" data={query.data?.items ?? []} loading={query.isFetching} pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: setPage }} columns={[
      { title: '昵称', dataIndex: 'nickname' }, { title: '账号', dataIndex: 'accountCode' }, { title: '开放时间', dataIndex: 'createdAt' }, { title: '操作', render: (_, row) => <Button type="text" status="warning" disabled={save.isPending} onClick={() => save.mutate({ id: row.userId, remove: true })}>撤销开放</Button> },
    ]} />
  </Drawer>
}
