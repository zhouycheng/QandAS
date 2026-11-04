import { useEffect, useState } from 'react'
import { Button, Input, Message, Modal } from '@arco-design/web-react'
import { setContentSafetyPrompt, type SafetyTicket } from '../lib/content-safety'

export function ContentSafetyDialog() {
  const [dialog, setDialog] = useState<{ ticket: SafetyTicket; cancel: () => void }>()
  useEffect(() => setContentSafetyPrompt((ticket, cancel) => {
    setDialog({ ticket, cancel })
    return () => setDialog(current => current?.ticket.id === ticket.id ? undefined : current)
  }), [])
  const code = dialog ? dialog.ticket.id + '.' + dialog.ticket.confirmationToken : ''
  const cancel = () => { dialog?.cancel(); setDialog(undefined) }
  return <Modal title="确认内容检查" visible={!!dialog} onCancel={cancel} maskClosable={false} footer={<Button onClick={cancel}>取消本次操作</Button>}>
    <p>在小程序管理员专用确认页粘贴确认码并确认，检查通过后将自动完成当前保存。</p>
    <p className="muted">专用页面路径：<code>page/content-confirm/index</code></p>
    <Input.TextArea value={code} readOnly autoSize={{ minRows: 3, maxRows: 5 }} aria-label="本次内容确认码" />
    <Button type="primary" onClick={() => { navigator.clipboard.writeText(code).then(() => Message.success('确认码已复制'), () => Message.error('复制失败，请手动复制确认码')) }}>复制确认码</Button>
    <p className="muted">确认码仅用于本次操作，请在有效期内使用。</p>
  </Modal>
}
