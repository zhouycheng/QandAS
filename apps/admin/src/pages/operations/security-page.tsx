import { useState } from 'react'
import { Alert, Button, Form, InputNumber, Message, Switch } from '@arco-design/web-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { ErrorState } from '../../components/error-state'
import { useAdminGateway } from '../../gateways/gateway-context'
import { ApiError } from '../../gateways/api-error'
import type { SecuritySettings } from '../../types/operations'
import { AgentSettings } from './agent-settings'

export function SecurityPage() {
  const gateway = useAdminGateway()
  const client = useQueryClient()
  const consent = useLocation().pathname === '/agent-authorize'
  const query = useQuery({ queryKey: ['security'], queryFn: () => gateway.getSecuritySettings(), enabled: !consent })
  const [baseline, setBaseline] = useState<SecuritySettings>()
  const record = baseline ?? query.data
  if (consent) return <AgentSettings consent />
  return <div className="security-workspace">
    <section className="op-sheet">
      {query.error && <ErrorState stale={!!query.data} message={query.error.message} onRetry={() => void query.refetch()} />}
      {record ? <SecurityEditor key={record.version} record={record} onDirtyChange={dirty => setBaseline(dirty ? record : undefined)}
        onReload={async () => { if ((await query.refetch()).isSuccess) setBaseline(undefined) }}
        onSaved={saved => { client.setQueryData(['security'], saved); setBaseline(undefined) }} /> : <>
        <h2>账号安全规则</h2>{query.isPending && <p role="status">正在加载安全规则…</p>}</>}
    </section>
    <AgentSettings />
  </div>
}

function SecurityEditor({ record, onDirtyChange, onReload, onSaved }: { record: SecuritySettings; onDirtyChange: (dirty: boolean) => void; onReload: () => Promise<void>; onSaved: (saved: SecuritySettings) => void }) {
  const gateway = useAdminGateway()
  const [dirty, setDirty] = useState(false)
  const save = useMutation({ mutationFn: (input: SecuritySettings) => gateway.saveSecuritySettings({ ...input, version: record.version }),
    onSuccess: saved => { onSaved(saved); setDirty(false); Message.success('安全规则已保存') } })
  return <Form<SecuritySettings> className="security-rules" initialValues={record} layout="horizontal" requiredSymbol={false} disabled={save.isPending}
    onValuesChange={(_, values) => {
      const changed = (Object.keys(values) as (keyof SecuritySettings)[]).some(key => values[key] !== record[key])
      onDirtyChange(changed)
      setDirty(changed)
      save.reset()
    }} onSubmit={values => { if (!save.isPending && dirty) save.mutate(values) }}>
    <header className="system-section-head"><h2>账号安全规则</h2><Button type="text" size="small" htmlType="submit" loading={save.isPending} disabled={!dirty}>保存规则</Button></header>
    <fieldset><legend>登录保护</legend>
      <Form.Item field="lockEnabled" label="连续失败后锁定" triggerPropName="checked"><Switch aria-label="连续失败后锁定" size="small" /></Form.Item>
      {([['maxAttempts', '允许失败次数', '次', 3, 10], ['lockMinutes', '锁定时长', '分钟', 1, 1440], ['sessionMinutes', '无操作退出时间', '分钟', 5, 1440]] as const)
        .map(([field, label, unit, min, max]) => <Form.Item key={field} field={field} label={label} rules={[{ required: true }]}>
          <InputNumber aria-label={label} suffix={unit} min={min} max={max} precision={0} /></Form.Item>)}
    </fieldset>
    <fieldset><legend>密码要求</legend>
      <Form.Item field="minPasswordLength" label="最短长度" rules={[{ required: true }]}><InputNumber aria-label="最短长度" suffix="位" min={8} max={64} precision={0} /></Form.Item>
      {([['requireLetter', '包含字母'], ['requireNumber', '包含数字'], ['requireMixedCase', '包含大小写字母']] as const).map(([field, label]) =>
        <Form.Item key={field} field={field} label={label} triggerPropName="checked"><Switch aria-label={label} size="small" /></Form.Item>)}
    </fieldset>
    {save.error && <Alert type="error" content={save.error.message} action={save.error instanceof ApiError && save.error.status === 409 &&
      <Button size="small" onClick={() => void onReload()}>载入最新规则</Button>} />}
  </Form>
}
