import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Button, Message, Modal, Table } from '@arco-design/web-react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ExcelPreview } from '../types/excel'
import { ResourceSelect } from './resource-select'
import { ExcelTransfer } from './excel-transfer'

const harness = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0,
  gateway: { previewExcel: vi.fn(), importExcel: vi.fn() }, onImported: vi.fn(),
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++
    if (index >= harness.states.length) harness.states.push(typeof initial === 'function' ? initial() : initial)
    return [harness.states[index], (value: unknown) => { harness.states[index] = typeof value === 'function' ? value(harness.states[index]) : value }]
  },
  useRef: () => ({ current: null }),
}))
vi.mock('@tanstack/react-query', () => ({ useQueries: () => [] }))
vi.mock('../gateways/gateway-context', () => ({ useAdminGateway: () => harness.gateway }))

function elements(node: ReactNode): ReactElement[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement(child)) return []
    const props = child.props as { children?: ReactNode; footer?: ReactNode }
    return [child, ...elements(props.children), ...elements(props.footer)]
  })
}
function render() {
  harness.cursor = 0
  return elements(ExcelTransfer({ resource: 'question-banks', onImported: harness.onImported }))
}
function button(nodes: ReactElement[], label: string) {
  return nodes.find(node => node.type === Button && Children.toArray((node.props as { children: ReactNode }).children).join('').startsWith(label))!.props as { disabled?: boolean; onClick: () => void }
}
function selectFiles(nodes: ReactElement[], files: File[]) {
  const input = nodes.find(node => node.type === 'input')!.props as { onChange: (event: { target: { files: File[]; value: string } }) => void }
  input.onChange({ target: { files, value: 'selected' } })
}
const preview: ExcelPreview = {
  valid: true, count: 60,
  files: [{ name: '题库.xlsx', fileId: 'file', count: 60, subject: '课程', bank: '题库', expectedContentVersion: 7 }], issues: [],
}

beforeEach(() => {
  harness.states = []; harness.cursor = 0; vi.clearAllMocks()
  vi.spyOn(Message, 'success').mockImplementation(vi.fn())
  vi.spyOn(Message, 'error').mockImplementation(vi.fn())
  harness.gateway.previewExcel.mockResolvedValue(preview)
  harness.gateway.importExcel.mockResolvedValue({})
})

it('未校验时禁止导入，更换文件清空已有预览和映射', async () => {
  let nodes = render()
  expect(button(nodes, '预览并校验').disabled).toBe(true)
  button(nodes, '确认导入').onClick()
  expect(harness.gateway.importExcel).not.toHaveBeenCalled()
  selectFiles(nodes, [new File(['workbook'], '题库.xlsx')])
  nodes = render(); button(nodes, '预览并校验').onClick()
  await vi.waitFor(() => expect(harness.states[4]).toBe(false))
  expect(button(render(), '确认导入').disabled).toBe(false)
  selectFiles(render(), [new File(['replacement'], '替换.xlsx')])
  expect(button(render(), '确认导入').disabled).toBe(true)
  expect(harness.states[3]).toEqual({ targets: {} })
})

it('修改追加目标后重新校验，正式导入带上最新内容版本', async () => {
  selectFiles(render(), [new File(['workbook'], '题库.xlsx')])
  button(render(), '预览并校验').onClick()
  await vi.waitFor(() => expect(harness.states[4]).toBe(false))
  const bank = render().find(node => node.type === ResourceSelect && (node.props as { kind: string }).kind === 'bank')!
  ;(bank.props as { onChange: (id: string) => void }).onChange('bank')
  expect(button(render(), '确认导入').disabled).toBe(true)
  button(render(), '确认导入').onClick()
  expect(harness.gateway.importExcel).not.toHaveBeenCalled()
  button(render(), '预览并校验').onClick()
  await vi.waitFor(() => expect(harness.states[4]).toBe(false))
  button(render(), '确认导入').onClick()
  await vi.waitFor(() => expect(harness.onImported).toHaveBeenCalledOnce())
  expect(harness.gateway.importExcel).toHaveBeenCalledWith('question-banks', expect.any(Array), { targets: { file: { bankId: 'bank', expectedContentVersion: 7, chapterMap: {} } } })
})

it('错误结果保留底部操作，少量提示不显示分页', async () => {
  harness.gateway.previewExcel.mockResolvedValue({ ...preview, valid: false, issues: [{ file: '题库.xlsx', sheet: '题目', row: 2, column: '答案', message: '请填写答案' }] })
  selectFiles(render(), [new File(['workbook'], '题库.xlsx')])
  button(render(), '预览并校验').onClick()
  await vi.waitFor(() => expect(harness.states[4]).toBe(false))
  const nodes = render()
  expect(button(nodes, '确认导入').disabled).toBe(true)
  const modal = nodes.find(node => node.type === Modal)!.props as { footer: ReactNode }
  expect(elements(modal.footer).filter(node => node.type === Button)).toHaveLength(3)
  const table = nodes.find(node => node.type === Table)!.props as { pagination: unknown; columns: { dataIndex: string }[] }
  expect(table.pagination).toBe(false)
  expect(table.columns.some(column => column.dataIndex === 'file')).toBe(false)
  expect(nodes.filter(node => (node.props as { title?: string }).title === '题库.xlsx')).toHaveLength(1)
})

it('多文件提示保留文件列以区分来源', () => {
  harness.states = [true, [], { ...preview, files: [...preview.files, { ...preview.files[0], name: '另一份.xlsx', fileId: 'other' }], issues: [{ file: '另一份.xlsx', sheet: '题目', row: 2, column: '答案', message: '请填写答案' }] }, { targets: {} }, false]
  const table = render().find(node => node.type === Table)!.props as { columns: { dataIndex: string }[] }
  expect(table.columns.some(column => column.dataIndex === 'file')).toBe(true)
})
