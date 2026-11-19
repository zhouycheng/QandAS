import { afterEach, expect, it, vi } from 'vitest'
import { Modal } from '@arco-design/web-react'
import { closeDraft, formHasChanges } from './unsaved-changes'

afterEach(() => vi.restoreAllMocks())

it('closes a restored form without confirmation', () => {
  const confirm = vi.spyOn(Modal, 'confirm')
  const close = vi.fn()
  const initial = { name: '', password: undefined, enabled: true }
  expect(formHasChanges(initial, { ...initial, enabled: false })).toBe(true)
  closeDraft(formHasChanges(initial, { name: '', enabled: true }), close)
  expect(confirm).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

it('keeps the draft on backdrop dismissal and discards only on confirmation', () => {
  const confirm = vi.spyOn(Modal, 'confirm').mockReturnValue({ close: vi.fn(), update: vi.fn() })
  const close = vi.fn()
  closeDraft(true, close)
  closeDraft(true, close)
  expect(confirm).toHaveBeenCalledTimes(1)
  const first = confirm.mock.calls[0][0]
  expect(first.maskClosable).toBe(true)
  first.onCancel?.()
  first.afterClose?.()
  expect(close).not.toHaveBeenCalled()
  closeDraft(true, close)
  const next = confirm.mock.calls[1][0]
  next.onOk?.()
  next.afterClose?.()
  expect(close).toHaveBeenCalledOnce()
})
