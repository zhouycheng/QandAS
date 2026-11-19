import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { LoginPage } from './login-page'

const mutation = vi.hoisted(() => ({ isSuccess: false }))
vi.mock('@tanstack/react-query', () => ({ useMutation: () => mutation }))
vi.mock('../../gateways/gateway-context', () => ({ useAdminGateway: () => ({}) }))
vi.mock('../../lib/auth', () => ({ isAuthenticated: () => true }))
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ state: { from: '/users?status=ACTIVE' } }),
  Navigate: ({ to }: { to: string }) => to,
}))
afterEach(() => vi.unstubAllGlobals())

it('刚完成登录时保留原页面与查询条件，已有会话访问登录页时进入概览', () => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  mutation.isSuccess = true
  expect(renderToStaticMarkup(<LoginPage />)).toBe('/users?status=ACTIVE')
  mutation.isSuccess = false
  expect(renderToStaticMarkup(<LoginPage />)).toBe('/dashboard')
})
