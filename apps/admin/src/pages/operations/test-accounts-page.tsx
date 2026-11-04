import { useEffect, useState } from 'react'
import { Alert, Button, Descriptions, Form, Input, InputNumber, Message, Modal, Select, Space, Switch, Table } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorState } from '../../components/error-state'
import { UserDetailDrawer } from '../../components/user-detail-drawer'
import { useAdminGateway } from '../../gateways/gateway-context'
import { testAccountDate, testAccountExpiry } from '../../lib/test-account-expiry'
import type { TestAccount, TestAccountCredentials, TestAccountInput, TestAccountQuery } from '../../types/operations'

const statusLabels = { ACTIVE: '有效', DISABLED: '已停用', EXPIRED: '已到期' }

export function TestAccountsPage() {
  const gateway = useAdminGateway(), client = useQueryClient()
  const [filter, setFilter] = useState<TestAccountQuery>({ page: 1 })
  const [creating, setCreating] = useState(false), [credentialsId, setCredentialsId] = useState<string>(), [profileId, setProfileId] = useState<string>()
  const query = useQuery({ queryKey: ['test-accounts', filter], queryFn: () => gateway.listTestAccounts(filter), refetchInterval: 30000 })
  const refresh = () => {
    for (const key of ['test-accounts', 'users', 'dashboard-summary', 'organization-directory', 'activity', 'online-users']) void client.invalidateQueries({ queryKey: [key] })
  }
  const disable = useMutation({ mutationFn: (row: TestAccount) => gateway.disableTestAccount(row.id, row.version), onSuccess: () => { refresh(); Message.success('测试账号已停用') }, onError: error => { refresh(); Message.error(error.message) } })
  return <section className="list-page" aria-label="测试账号管理">
    <Space className="list-toolbar" wrap>
      <Button type="primary" onClick={() => setCreating(true)}>新建测试账号</Button>
      <Input.Search aria-label="搜索测试账号" placeholder="登录账号或账号编号" value={filter.keyword} allowClear onChange={keyword => setFilter({ ...filter, keyword, page: 1 })} />
      <Select aria-label="测试账号状态" placeholder="全部状态" style={{ width: 140 }} allowClear value={filter.status} options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))} onChange={status => setFilter({ ...filter, status, page: 1 })} />
    </Space>
    {query.error && <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />}
    <Table<TestAccount> rowKey="id" data={query.data?.items ?? []} loading={query.isFetching} scroll={{ x: 1050 }} pagination={{ current: filter.page, pageSize: 20, total: query.data?.total ?? 0, showTotal: true, onChange: page => setFilter({ ...filter, page }) }} columns={[
      { title: '登录账号', dataIndex: 'email' },
      { title: '创建时间（北京时间）', render: (_, row) => testAccountDate(row.createdAt) },
      { title: '到期时间（北京时间）', render: (_, row) => testAccountDate(row.expiresAt) },
      { title: '状态', render: (_, row) => statusLabels[row.status] },
      { title: '计入运营统计', render: (_, row) => row.includeInStatistics ? '是' : '否' },
      { title: '操作', render: (_, row) => <Space>
        <Button type="text" disabled={row.status !== 'ACTIVE' || Date.parse(row.expiresAt) <= Date.now()} onClick={() => setCredentialsId(row.id)}>查看凭据</Button>
        <Button type="text" onClick={() => setProfileId(row.id)}>学生资料</Button>
        <Button type="text" status="warning" disabled={row.status !== 'ACTIVE' || disable.isPending} onClick={() => Modal.confirm({ title: '停用测试账号？', content: '停用后退出全部登录，保留账号和学习记录。', okText: '停用', cancelText: '取消', onOk: () => disable.mutateAsync(row) })}>提前停用</Button>
      </Space> },
    ]} />
    {creating && <TestAccountEditor onClose={() => setCreating(false)} onSaved={row => { setCreating(false); setCredentialsId(row.id); refresh() }} />}
    {credentialsId && <CredentialsDialog id={credentialsId} onClose={() => setCredentialsId(undefined)} />}
    {profileId && <UserDetailDrawer id={profileId} onClose={() => { setProfileId(undefined); refresh() }} />}
  </section>
}

function TestAccountEditor({ onClose, onSaved }: { onClose: () => void; onSaved: (row: TestAccount) => void }) {
  const gateway = useAdminGateway()
  const [days, setDays] = useState(7), [included, setIncluded] = useState(false)
  const save = useMutation({ mutationFn: (input: TestAccountInput) => gateway.createTestAccount(input), onSuccess: onSaved })
  const expiry = testAccountExpiry(days)
  return <Modal visible style={{ maxWidth: 'calc(100vw - 32px)' }} title="新建测试账号" maskClosable={false} onCancel={() => { if (!save.isPending) onClose() }} onOk={() => { if (expiry) save.mutate({ validDays: days, includeInStatistics: included }); else Message.error('请输入 1–365 的整数天数') }} confirmLoading={save.isPending} okText="创建" cancelText="取消">
    {save.error && <Alert type="error" content={save.error.message} />}
    <Form layout="vertical" disabled={save.isPending}>
      <Form.Item label="有效天数" required><InputNumber aria-label="有效天数" min={1} max={365} value={days} onChange={setDays} /></Form.Item>
      <p className="muted">{expiry ? `预计到期时间：${testAccountDate(expiry)}（北京时间）` : '请输入有效天数'}；以创建成功后的时间为准。</p>
      <Form.Item label="计入运营统计"><Switch aria-label="计入运营统计" checked={included} onChange={setIncluded} /></Form.Item>
      <p className="muted">开启后计入用户量、活跃度和答题等运营统计。账号和16位测试登录码由系统生成，到期自动停用并保留学习记录。</p>
    </Form>
  </Modal>
}

function CredentialsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const gateway = useAdminGateway()
  const [credentials, setCredentials] = useState<TestAccountCredentials>(), [error, setError] = useState('')
  useEffect(() => {
    let active = true, expiry = Infinity
    const clear = () => { active = false; setCredentials(undefined); setError('凭据已清除，请关闭后重新查看') }
    void gateway.getTestAccountCredentials(id).then(value => {
      if (!active) return
      expiry = Date.parse(value.expiresAt)
      if (expiry <= Date.now()) { clear(); return }
      setCredentials(value)
    }).catch(reason => { if (active) setError(reason.message) })
    const timer = setInterval(() => { if (Date.now() >= expiry) clear() }, 1000)
    window.addEventListener('storage', clear)
    return () => { active = false; clearInterval(timer); window.removeEventListener('storage', clear) }
  }, [gateway, id])
  const copy = async () => {
    if (!credentials || Date.parse(credentials.expiresAt) <= Date.now()) { setCredentials(undefined); setError('测试账号已到期'); return }
    try { await navigator.clipboard.writeText(`账号：${credentials.email}\n测试登录码：${credentials.password}`); Message.success('账号和测试登录码已复制') }
    catch { Message.error('复制失败，请手动复制') }
  }
  return <Modal visible style={{ maxWidth: 'calc(100vw - 32px)' }} title="测试账号凭据" onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    {error ? <Alert type="error" content={error} /> : credentials ? <>
      <Descriptions column={1} data={[{ label: '登录账号', value: credentials.email }, { label: '测试登录码', value: credentials.password }, { label: '到期时间（北京时间）', value: testAccountDate(credentials.expiresAt) }]} />
      <Button type="primary" onClick={() => void copy()}>复制账号和测试登录码</Button>
    </> : <p>正在读取凭据…</p>}
  </Modal>
}
