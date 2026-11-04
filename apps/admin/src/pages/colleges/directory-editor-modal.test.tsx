import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ContentStatus } from '../../types/admin'
import { DirectoryEditorModal, type EditorTarget } from './directory-editor-modal'

type Values = { name: string; status: ContentStatus }
const harness = vi.hoisted(() => ({
  save: (_values: Values): Promise<unknown> => Promise.resolve(),
  gateway: { createCollege: vi.fn(), updateCollege: vi.fn(), createMajor: vi.fn(), updateMajor: vi.fn() },
}))
vi.mock('@tanstack/react-query', () => ({
  useMutation: ({ mutationFn }: { mutationFn: (values: Values) => Promise<unknown> }) => {
    harness.save = mutationFn
    return { isPending: false }
  },
}))
vi.mock('../../gateways/gateway-context', () => ({ useAdminGateway: () => harness.gateway }))

const college = { id: 'college', name: '学院', code: 'existing-college', status: 'ACTIVE' as const, version: 3, createdAt: '', updatedAt: '' }
const values: Values = { name: '新名称', status: 'ACTIVE' }
function render(target: EditorTarget) {
  renderToStaticMarkup(<DirectoryEditorModal target={target} onCancel={() => {}} onSaved={() => {}} />)
}

beforeEach(() => vi.clearAllMocks())

it.each(['college', 'major'] as const)('新增 %s 无需填写代码，重试沿用同一自动代码', async kind => {
  render(kind === 'college' ? { kind } : { kind, college })
  await harness.save(values)
  await harness.save(values)
  const create = kind === 'college' ? harness.gateway.createCollege : harness.gateway.createMajor
  const input = create.mock.calls[0][0]
  expect(input).toMatchObject(values)
  expect(input.code).toEqual(expect.any(String))
  expect(input.code.length).toBeGreaterThan(0)
  expect(input.code.length).toBeLessThanOrEqual(40)
  expect(create.mock.calls[1][0].code).toBe(input.code)
  if (kind === 'major') expect(input.collegeId).toBe(college.id)
})

it.each(['college', 'major'] as const)('编辑 %s 保留原代码及业务版本', async kind => {
  const record = { ...college, id: 'entry', code: 'existing-code', collegeId: college.id }
  render(kind === 'college' ? { kind, record } : { kind, college, record })
  await harness.save(values)
  const update = kind === 'college' ? harness.gateway.updateCollege : harness.gateway.updateMajor
  expect(update).toHaveBeenCalledWith(record.id, expect.objectContaining({ ...values, code: record.code, expectedVersion: record.version }))
})
