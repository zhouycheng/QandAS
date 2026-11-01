import { Alert, Button, Message, Modal, Tag } from '@arco-design/web-react'
import { IconCheckCircleFill, IconCloseCircleFill } from '@arco-design/web-react/icon'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import type { QuestionBank } from '../../types/admin'
import { refreshWorkbench } from './workbench-data'

export function PublicationModal({ bank, onClose }: {
  bank: QuestionBank; onClose: () => void
}) {
  const gateway = useAdminGateway()
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['publication-checks', bank.id, bank.version], queryFn: () => gateway.publicationChecks(bank.id) })
  const checks = query.data ?? []
  const passed = checks.length > 0 && checks.every(check => check.passed)
  const publish = useMutation({
    mutationFn: () => gateway.setBankPublication(bank.id, 'PUBLISHED', bank.version),
    onSuccess: () => { refreshWorkbench(client); Message.success('题库已发布，将按展示范围匹配学生资料'); onClose() },
  })
  return <Modal className="bw-publication-modal" title="发布检查" visible style={{ width: 600, maxWidth: 'calc(100vw - 32px)' }} maskClosable={false}
    closable={!publish.isPending} escToExit={!publish.isPending} onCancel={() => { if (!publish.isPending) onClose() }}
    footer={<><Button disabled={publish.isPending} onClick={onClose}>{passed ? '取消' : '返回完善'}</Button><Button type="primary" disabled={!passed} loading={publish.isPending} onClick={() => publish.mutate()}>确认发布</Button></>}>
    <div className="bw-publication-heading"><strong>{bank.name}</strong><Tag color={passed ? 'green' : 'orange'}>已通过 {checks.filter((c) => c.passed).length} / {checks.length} 项</Tag></div>
    {query.error && <Alert type="error" content={query.error.message} action={<Button onClick={() => void query.refetch()}>重试</Button>} />}
    {query.isPending && <p>正在检查发布条件…</p>}
    {publish.error && <Alert type="error" content={publish.error.message} style={{ marginBottom: 16 }} />}
    <div className="bw-checklist">{checks.map((check) => <div className={check.passed ? 'passed' : 'failed'} key={check.label}>{check.passed ? <IconCheckCircleFill /> : <IconCloseCircleFill />}<div><strong>{check.label}</strong><p>{check.detail}</p></div></div>)}</div>
    <p className="bw-form-note">发布后向匹配范围的学生展示。之后可下架题库，保留内容与已有记录。</p>
  </Modal>
}
