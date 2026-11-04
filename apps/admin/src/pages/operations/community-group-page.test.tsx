import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Button, Message, Upload } from '@arco-design/web-react'
import { beforeEach, expect, it, vi } from 'vitest'
import { CommunityGroupPage } from './community-group-page'
import { defaultCommunityGroupExpiry } from '../../lib/community-group-expiry'

const harness = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, pending: false,
  save: (): Promise<unknown> => Promise.resolve(), gateway: { saveCommunityGroup: vi.fn(), communityGroupImage: vi.fn() },
  read: vi.fn(),
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++
    if (index >= harness.states.length) harness.states.push(typeof initial === 'function' ? initial() : initial)
    return [harness.states[index], (value: unknown) => { harness.states[index] = value }]
  },
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { version: 4, available: false, expiresAt: null } }),
  useMutation: ({ mutationFn }: { mutationFn: () => Promise<unknown> }) => { harness.save = mutationFn; return { isPending: harness.pending } },
}))
vi.mock('../../gateways/gateway-context', () => ({ useAdminGateway: () => harness.gateway }))
function elements(node: ReactNode): ReactElement[] {
  return Children.toArray(node).flatMap(child => isValidElement(child) ? [child, ...elements((child.props as { children?: ReactNode }).children)] : [])
}
function render() { harness.cursor = 0; return elements(CommunityGroupPage()) }
function upload() { return render().find(node => node.type === Upload)!.props as { drag: boolean; autoUpload: boolean; disabled: boolean; beforeUpload: (file: File) => boolean } }

beforeEach(() => {
  harness.states = []; harness.cursor = 0; harness.pending = false; vi.clearAllMocks()
  vi.spyOn(Message, 'error').mockImplementation(vi.fn())
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,preview'
    onload?: () => void
    readAsDataURL(file: File) { harness.read(file); this.onload?.() }
  })
})

it('拖入图片只做本地预览，保存时使用当前版本与七天有效期', async () => {
  const control = upload()
  expect(control.drag).toBe(true)
  expect(control.autoUpload).toBe(false)
  expect(control.beforeUpload(new File(['image'], '二维码.png', { type: 'image/png' }))).toBe(false)
  expect(harness.gateway.saveCommunityGroup).not.toHaveBeenCalled()
  expect(harness.states[1]).toBe(defaultCommunityGroupExpiry())
  const nodes = render()
  expect(nodes.some(node => node.type === 'img' && (node.props as { alt: string }).alt === '待保存的群二维码')).toBe(true)
  const save = nodes.find(node => node.type === Button)!.props as { disabled: boolean }
  expect(save.disabled).toBe(false)
  await harness.save()
  expect(harness.gateway.saveCommunityGroup).toHaveBeenCalledWith({ expectedVersion: 4, image: 'data:image/png;base64,preview', expiresAt: expect.any(String) })
})

it('不接受非图片或超过 5 MiB 的文件', () => {
  upload().beforeUpload(new File(['text'], '说明.txt', { type: 'text/plain' }))
  upload().beforeUpload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], '过大.png', { type: 'image/png' }))
  expect(Message.error).toHaveBeenCalledTimes(2)
  expect(harness.read).not.toHaveBeenCalled()
  expect(harness.states[0]).toBe('')
})

it('保存期间禁用选择和拖拽替换', () => {
  harness.pending = true
  const control = upload()
  expect(control.disabled).toBe(true)
  control.beforeUpload(new File(['image'], '二维码.png', { type: 'image/png' }))
  expect(harness.read).not.toHaveBeenCalled()
})
