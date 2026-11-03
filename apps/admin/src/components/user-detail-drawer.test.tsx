import { beforeEach, expect, it, vi } from 'vitest'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Button, Form } from '@arco-design/web-react'
import type { ManagedUser } from '../types/operations'
import { UserDetailDrawer } from './user-detail-drawer'

const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, profile: {} as ManagedUser, mutate: vi.fn() }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++
    if (index >= harness.states.length) harness.states.push(initial)
    return [harness.states[index], (value: unknown) => { harness.states[index] = value }]
  },
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[0] === 'user' ? harness.profile : { durationSeconds: 0 } }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: harness.mutate, reset: vi.fn(), isPending: false }),
}))
vi.mock('../gateways/gateway-context', () => ({ useAdminGateway: () => ({}) }))

function elements(node: ReactNode): ReactElement[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement(child)) return []
    const props = child.props as { children?: ReactNode; footer?: ReactNode }
    return [child, ...elements(props.children), ...elements(props.footer)]
  })
}
function render() { harness.cursor = 0; return elements(UserDetailDrawer({ id: 'student', onClose() {} })) }
function click(nodes: ReactElement[], label: string) {
  const element = nodes.find(node => node.type === Button && (node.props as { children: ReactNode }).children === label)!
  ;(element.props as { onClick: () => void }).onClick()
}
function form(nodes: ReactElement[]) {
  return nodes.find(node => node.type === Form)!.props as { initialValues: Record<string, unknown>; onSubmit: (values: object) => void }
}
beforeEach(() => {
  harness.states = []; harness.cursor = 0; harness.mutate.mockClear()
  harness.profile = { id: 'student', version: 1, name: '原昵称', account: 'QA001', email: 'old@example.test', collegeId: '', majorId: '', wechatBound: false, status: 'ACTIVE' }
  vi.spyOn(Form, 'useForm').mockReturnValue([{} as ReturnType<typeof Form.useForm>[0]])
})
it('keeps the edit snapshot across query refreshes and uses fresh data only after reopening', () => {
  click(render(), '编辑资料')
  harness.profile = { ...harness.profile, version: 2, name: '他人更新', email: 'new@example.test' }
  let nodes = render(), editing = form(nodes)
  expect(editing.initialValues.nickname).toBe('原昵称')
  expect(editing.initialValues.email).toBe('old@example.test')
  editing.onSubmit({ ...editing.initialValues, nickname: '未提交草稿' })
  expect(harness.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 1, nickname: '未提交草稿', email: 'old@example.test' }))
  click(nodes, '取消'); click(render(), '编辑资料')
  nodes = render(); editing = form(nodes)
  expect(editing.initialValues.nickname).toBe('他人更新')
  editing.onSubmit(editing.initialValues)
  expect(harness.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 2, email: 'new@example.test' }))
})
