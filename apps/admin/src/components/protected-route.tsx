import type { PropsWithChildren } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { getAdminSession, isAuthenticated } from '../lib/auth'

export function ProtectedRoute({ children, platformOnly = false }: PropsWithChildren<{ platformOnly?: boolean }>) {
  const location = useLocation()
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  if (platformOnly && getAdminSession()?.role !== 'PLATFORM_ADMIN') return <Navigate to="/question-banks" replace />
  return children
}
