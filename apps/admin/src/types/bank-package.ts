export interface AgentDirectory {
  resource: string
  agents: { id: string; client: string; scope: string; expires_at: string }[]
}
export interface PackageResult {
  digest: string
  contentVersion: number
  changes: { portableId: string; action: 'CREATE' | 'UPDATE' | 'SKIP'; fields: string[]; differences: Record<string, [unknown, unknown]> }[]
  newChapters: string[]
}
export interface PackageRequest {
  uploadId: string
  chapterMap?: Record<string, string>
  digest?: string
  expectedContentVersion?: number
  confirmUpdates?: boolean
}
