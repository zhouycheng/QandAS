export interface SafetyTicket { id: string; state: string; expiresAt: string; confirmationToken?: string; errorCode?: string }
type Prompt = (ticket: SafetyTicket, cancel: () => void) => () => void
let prompt: Prompt | undefined
let cancelPending: (() => void) | undefined
export function setContentSafetyPrompt(next: Prompt) { prompt = next; return () => { if (prompt === next) { prompt = undefined; cancelPending?.() } } }
export function openContentSafetyPrompt(ticket: SafetyTicket, cancel: () => void) {
  if (!prompt) throw new Error('内容确认窗口尚未就绪，请重试')
  if (cancelPending) throw new Error('请先完成或取消正在进行的内容确认')
  cancelPending = cancel
  try { const close = prompt(ticket, cancel); return () => { if (cancelPending === cancel) cancelPending = undefined; close() } }
  catch (error) { cancelPending = undefined; throw error }
}
export function needsContentCheck(method: string, path: string, body: unknown) {
  if (path.includes('/content-safety/')) return false
  if (method === 'PUT' && /^\/admin\/question-banks\/[^/]+\/publication$/.test(path)) return (body as { status?: string })?.status === 'PUBLISHED'
  return method === 'POST' && /^\/admin\/(colleges|majors|subjects|question-banks|questions|announcements)$/.test(path)
    || method === 'PUT' && /^\/admin\/(colleges|majors|subjects|question-banks|questions|announcements|users|question-feedback|course-requests)\/[^/]+$/.test(path)
    || method === 'POST' && /^\/admin\/question-banks\/[^/]+\/(chapters|imports)$/.test(path)
    || method === 'PUT' && /^\/admin\/question-banks\/[^/]+\/chapters\/[^/]+$/.test(path)
    || method === 'PUT' && path === '/admin/community/group'
}
