import type { CreateQuestionInput, PageQuery, Versioned } from './admin'

export type UserStatus = 'ACTIVE' | 'PENDING' | 'DISABLED'
export type LoginPlatform = 'MINI_PROGRAM' | 'WEB'

export interface ManagedUser extends Versioned {
  id: string
  name: string
  account: string
  email: string
  wechatBound: boolean
  avatarUrl?: string | null
  collegeId: string
  majorId: string
  grade?: number
  collegeName?: string
  majorName?: string
  registeredAt?: string
  status: UserStatus
  answeredCount?: number
  activeDays?: number
  preferredHours?: string
  platforms?: LoginPlatform[]
  lastActiveAt?: string
}
export interface UserQuery extends PageQuery {
  keyword?: string
  collegeId?: string
  majorId?: string
  status?: UserStatus
  grade?: number
}

export interface AdminAccount extends Versioned {
  id: string
  name: string
  username: string
  status: 'ACTIVE' | 'DISABLED'
  role: 'SUPER_ADMIN'
  createdAt: string
  lastLoginAt?: string
}
export interface AdminAccountInput {
  name: string
  username: string
  status?: AdminAccount['status']
  role?: AdminAccount['role']
  password?: string
  expectedVersion?: number
}
export interface AdminLogin { account: AdminAccount; accessToken: string; expiresAt: string; sessionMinutes: number }
export interface StoredAdminAccount extends AdminAccount {
  passwordHash: string
  credentialVersion?: number
}

export type AnnouncementStatus = 'DRAFT' | 'PUBLISHED' | 'SCHEDULED'
export interface Announcement extends Versioned {
  id: string
  title: string
  summary: string
  body: string
  audience: 'ALL' | 'SELECTED'
  userIds: string[]
  platforms: LoginPlatform[]
  status: AnnouncementStatus
  publishAt?: string
  updatedAt: string
}
export type AnnouncementInput = Omit<Announcement, 'id' | 'updatedAt' | 'version'> & { expectedVersion?: number }

export interface UserCourse {
  userId: string
  subjectId: string
  preferredBankId?: string
  addedAt: string
}

export type FeedbackStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'DISMISSED'
export interface StudentFeedback extends Versioned {
  id: string
  kind: 'QUESTION' | 'COURSE_REQUEST'
  userId: string
  title: string
  body: string
  category: string
  questionId?: string
  questionBankId?: string
  questionRevision?: number
  questionSnapshot?: import('./admin').QuestionContent
  status: FeedbackStatus
  response: string
  createdAt: string
  updatedAt: string
}

export interface SecuritySettings extends Versioned {
  lockEnabled: boolean
  maxAttempts: number
  lockMinutes: number
  sessionMinutes: number
  minPasswordLength: number
  requireLetter: boolean
  requireNumber: boolean
  requireMixedCase: boolean
  updatedAt?: string
}

export interface OperationLog {
  id: string
  createdAt: string
  actor: string
  module: string
  content: string
  result: 'SUCCESS' | 'FAILURE'
  ip: string
}
export interface LogQuery extends PageQuery {
  keyword?: string
  module?: string
  result?: OperationLog['result']
  start?: string
  end?: string
}

export interface ActivityRecord {
  date: string
  platform: LoginPlatform
  userIds: string[]
  newUsers: number
  returningUsers: number
  answeredCount: number
  correctCount: number
  hours: number[]
  learning: { userId: string; answeredCount: number; correctCount: number; durationSeconds: number }[]
}
export interface ForegroundSession { userId: string; platform: LoginPlatform; seenAt: string; expiresAt: string; revoked: boolean }
export interface ActivityQuery extends PageQuery {
  period?: 'DAY' | 'WEEK' | 'MONTH' | 'ALL'
  periodDate?: string
  platform?: LoginPlatform
  collegeId?: string
  majorId?: string
  grade?: number
  sort?: 'ACTIVE_DAYS' | 'ANSWERED_COUNT' | 'DURATION'
}
export interface ActivitySummary {
  dailyActive: number
  weeklyActive: number
  monthlyActive: number
  retention: number
  activeUsers: number
  onlineUsers: number
  updatedAt: string
  records: { date: string; activeUsers: number }[]
}
export interface RankingRow { rank: number; userId: string; nickname: string; accountCode: string; collegeName?: string; majorName?: string; currentGrade?: number; activeDays: number; answeredCount: number; correctCount: number; durationSeconds: number; lastActiveAt?: string }
export interface SubjectAccess { userId: string; nickname: string; accountCode: string; createdAt: string }
export interface ImportQuestionsInput {
  questionBankId: string
  questions: CreateQuestionInput[]
  expectedContentVersion: number
  idempotencyKey: string
}
