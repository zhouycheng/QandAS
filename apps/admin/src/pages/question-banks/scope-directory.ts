import { useQueries } from '@tanstack/react-query'
import { useAdminGateway } from '../../gateways/gateway-context'
import { getAdminSession } from '../../lib/auth'
import type { BankCategory } from '../../types/admin'

export function useScopeDirectory(categories: BankCategory[]) {
  const gateway = useAdminGateway()
  const ids = (key: 'collegeId' | 'majorId') => [...new Set(categories.flatMap(row => row[key] ? [row[key]!] : []))]
  const colleges = useQueries({ queries: ids('collegeId').map(id => ({ queryKey: ['scope-college', getAdminSession()?.id, id], staleTime: 300000, queryFn: () => gateway.getCollege(id) })) })
  const majors = useQueries({ queries: ids('majorId').map(id => ({ queryKey: ['scope-major', getAdminSession()?.id, id], staleTime: 300000, queryFn: () => gateway.getMajor(id) })) })
  return { colleges: colleges.flatMap(q => q.data ? [q.data] : []), majors: majors.flatMap(q => q.data ? [q.data] : []) }
}
