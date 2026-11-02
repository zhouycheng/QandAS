import type { Page } from './admin'
import type { ActivityQuery, LoginPlatform } from './operations'

export type OnlineQuery = Pick<ActivityQuery, 'collegeId' | 'majorId' | 'grade' | 'platform' | 'page' | 'pageSize'> & { keyword?: string }
export interface OnlineUser {
  userId: string; nickname: string; accountCode: string; collegeName?: string; majorName?: string; currentGrade?: number
  onlineSessionCount: number; lastHeartbeatAt: string
  clients: { platform: LoginPlatform; sessionCount: number; lastHeartbeatAt: string }[]
}
export type OnlineUsers = Page<OnlineUser> & { sampledAt: string }
export interface SyncSnapshot {
  sampledAt: string | null; checkedAt: string; windowSeconds: number
  status: 'HEALTHY' | 'SAMPLING' | 'RESET' | 'STALE' | 'UNAVAILABLE'; reason: string | null
  metrics: { queued: number | null; processing: number | null; productionPerSecond: number | null; consumptionPerSecond: number | null; committedPerSecond: number | null; retrying: number | null; deadLetters: number | null; consumers: number | null; averageLatencyMs: number | null; p95LatencyMs: number | null }
}
export interface SystemHealth {
  sampledAt: string | null; components: { name: string; status: string }[]
  endpoints: { method: string; path: string; requestsPerSecond: number | null; errorsPerSecond: number | null; p95Seconds: number | null }[]
  activityPending: number | null; mailPending: number | null; sync: SyncSnapshot
}
export type StreamStatus = 'CONNECTING' | 'LIVE' | 'RECONNECTING' | 'AUTH_EXPIRED'
export interface DeadLetterHead { item: { commandId: string | null; sessionId: string | null; failure: { code: string; message: string; status: number } | null; reason: string | null } | null }
