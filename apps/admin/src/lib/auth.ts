import type { AdminAccount, AdminLogin } from '../types/operations'

const AUTH_KEY = 'qanda-admin-auth'
export interface AdminSession {
  id: string
  username: string
  name: string
  lastActivity: number
  timeoutMinutes: number
  accessToken: string
  expiresAt: string
  role: AdminAccount['role']
}
export function getAdminSession(): AdminSession | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(AUTH_KEY) ?? 'null') as AdminSession | null
    return value &&
      typeof value.id === 'string' &&
      typeof value.username === 'string' &&
      typeof value.accessToken === 'string' && value.accessToken.length > 0 &&
      value.role === 'SUPER_ADMIN' &&
      Number.isFinite(Date.parse(value.expiresAt)) &&
      Number.isFinite(value.lastActivity) &&
      Number.isFinite(value.timeoutMinutes) &&
      value.timeoutMinutes >= 5 &&
      value.timeoutMinutes <= 1440
      ? value
      : null
  } catch {
    return null
  }
}
export function isAuthenticated() {
  const session = getAdminSession()
  return Boolean(session && Date.now() < Date.parse(session.expiresAt) && Date.now() - session.lastActivity < session.timeoutMinutes * 60000)
}
export function saveAdminSession({ account, accessToken, expiresAt, sessionMinutes }: AdminLogin) {
  window.localStorage.setItem(
    AUTH_KEY,
    JSON.stringify({
      id: account.id,
      username: account.username,
      name: account.name,
      lastActivity: Date.now(),
      timeoutMinutes: sessionMinutes,
      accessToken, expiresAt, role: account.role,
    }),
  )
}
export function touchAdminSession(timeoutMinutes: number) {
  const session = getAdminSession()
  if (session)
    window.localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({ ...session, timeoutMinutes, lastActivity: Date.now() }),
    )
}
export function logout() {
  window.localStorage.removeItem(AUTH_KEY)
}
