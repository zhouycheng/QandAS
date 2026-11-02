import { createContext, useContext, type PropsWithChildren } from 'react'
import type { AdminContentGateway } from './admin-content-gateway'

const GatewayContext = createContext<AdminContentGateway | null>(null)

export function GatewayProvider({
  gateway,
  children,
}: PropsWithChildren<{ gateway: AdminContentGateway }>) {
  return <GatewayContext.Provider value={gateway}>{children}</GatewayContext.Provider>
}

export function useAdminGateway() {
  const gateway = useContext(GatewayContext)
  if (!gateway) {
    throw new Error('页面暂时无法加载，请重新打开')
  }
  return gateway
}
