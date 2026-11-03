import { useState } from 'react'
import { Alert, Button, Select } from '@arco-design/web-react'
import { useInfiniteQuery, useQueries } from '@tanstack/react-query'
import { useAdminGateway } from '../gateways/gateway-context'
import { getAdminSession } from '../lib/auth'

export function ResourceSelect({ kind, collegeId, value, onChange, multiple, disabled, placeholder, initialOptions = [] }: {
  kind: 'college' | 'major' | 'subject' | 'bank' | 'user' | 'admin'; collegeId?: string
  value?: string | string[]; onChange?: (value: string | string[]) => void
  multiple?: boolean; disabled?: boolean; placeholder: string; initialOptions?: { value: string; label: string }[]
}) {
  const gateway = useAdminGateway()
  const [opened, setOpened] = useState(false)
  const [keyword, setKeyword] = useState('')
  const selected = (Array.isArray(value) ? value : value ? [value] : []).filter(id => !initialOptions.some(option => option.value === id))
  const selectedQueries = useQueries({ queries: selected.map(id => ({ queryKey: ['resource-label', getAdminSession()?.id, kind, id], staleTime: 300000, queryFn: async () => {
    const item = kind === 'bank' ? await gateway.getQuestionBank(id) : kind === 'college' ? await gateway.getCollege(id) : kind === 'major' ? await gateway.getMajor(id) : kind === 'subject' ? await gateway.getSubject(id) : kind === 'admin' ? await gateway.getAdminAccount(id) : await gateway.getUser(id)
    return { value: id, label: item.name }
  } })) })
  const query = useInfiniteQuery({
    queryKey: ['resource-select', getAdminSession()?.id, kind, collegeId, keyword], enabled: opened,
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const params = { page: pageParam, pageSize: 20, keyword }
      if (kind === 'college') { const data = await gateway.listColleges(params); return { ...data, items: data.items.map(x => ({ value: x.id, label: x.name + (x.status === 'INACTIVE' ? '（已停用）' : '') })) } }
      if (kind === 'major') { const data = await gateway.listMajors({ ...params, collegeId }); return { ...data, items: data.items.map(x => ({ value: x.id, label: x.name + (x.status === 'INACTIVE' ? '（已停用）' : '') })) } }
      if (kind === 'bank') { const data = await gateway.listQuestionBanks(params); return { ...data, items: data.items.map(x => ({ value: x.id, label: x.name })) } }
      if (kind === 'subject') { const data = await gateway.listSubjects(params); return { ...data, items: data.items.map(x => ({ value: x.id, label: x.name })) } }
      if (kind === 'user') { const data = await gateway.listUsers({ ...params, status: 'ACTIVE' }); return { ...data, items: data.items.map(x => ({ value: x.id, label: x.name + ' · ' + x.account })) } }
      const data = await gateway.listAdminAccounts(params)
      return { ...data, items: data.items.filter(x => x.status === 'ACTIVE').map(x => ({ value: x.id, label: x.name + ' · ' + x.username })) }
    },
    getNextPageParam: last => last.page * last.pageSize < last.total ? last.page + 1 : undefined,
  })
  const options = [...new Map([...initialOptions, ...selectedQueries.flatMap(item => item.data ? [item.data] : []), ...(query.data?.pages.flatMap(p => p.items) ?? [])].map(x => [x.value, x])).values()]
  return <Select style={{ width: '100%', minWidth: 160 }} aria-label={placeholder} placeholder={placeholder} value={value} onChange={onChange} mode={multiple ? 'multiple' : undefined} disabled={disabled} allowClear
    showSearch={kind !== 'admin'} filterOption={false} onSearch={setKeyword} loading={query.isFetching} onVisibleChange={visible => { if (visible) setOpened(true) }} options={options}
    dropdownRender={menu => <>{menu}{query.error && <Alert type="error" content={query.error.message} action={<Button size="mini" onClick={() => void query.refetch()}>重试</Button>} />}{query.hasNextPage && <Button long type="text" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多</Button>}</>} />
}
