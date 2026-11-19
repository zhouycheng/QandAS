import { Modal } from '@arco-design/web-react'

export function formHasChanges<T extends object>(initial: T, current: Partial<T>) {
  return (Object.keys(initial) as (keyof T)[]).some(key => (initial[key] ?? '') !== (current[key] ?? ''))
}

let confirming = false

export function closeDraft(changed: boolean, close: () => void, content = '关闭后，本次修改将丢失。') {
  if (confirming) return
  if (!changed) return close()
  confirming = true
  Modal.confirm({
    title: '放弃未保存的修改？', content, okText: '放弃修改', cancelText: '继续编辑',
    maskClosable: true, maskStyle: { zIndex: 1200 }, wrapStyle: { zIndex: 1201 },
    onOk: close, afterClose: () => { confirming = false },
  })
}
