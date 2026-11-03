import type { TestAccount, TestAccountInput, TestAccountCredentials, TestAccountQuery } from '../types/operations'
import type { AdminContentGateway } from './admin-content-gateway'
import type { BankPublicationStatus, Chapter, College, CollegeQuery, CreateCollegeInput, CreateMajorInput, CreateQuestionBankInput, CreateQuestionInput, CreateSubjectInput, DashboardSummary, DirectorySummary, Major, MajorQuery, Page, PageQuery, PublicationCheck, Question, QuestionBank, QuestionBankQuery, QuestionQuery, Subject, SubjectQuery, UpdateCollegeInput, UpdateMajorInput, UpdateQuestionBankInput, UpdateQuestionInput, UpdateSubjectInput } from '../types/admin'
import type { ActivityQuery, ActivitySummary, AdminAccount, AdminAccountInput, AdminLogin, Announcement, AnnouncementInput, ImportQuestionsInput, LogQuery, ManagedUser, OperationLog, RankingRow, SecuritySettings, StudentFeedback, SubjectAccess, UpdateManagedUserInput, UserQuery, UserStatus } from '../types/operations'
import { getAdminSession, logout } from '../lib/auth'
import { importBody, questionFromWire, questionToWire } from './question-wire'
import { countQuestions } from '../lib/question-content'
import { ApiError } from './api-error'
import type { OnlineQuery, OnlineUsers, SyncSnapshot, SystemHealth, StreamStatus } from '../types/monitoring'
import { watchSyncStream } from './sync-stream'
export { ApiError } from './api-error'

type Mutation = { id: string; version: number }
type WireUser = { isTestAccount?: boolean; id: string; nickname: string; accountCode: string; version: number; email?: string; collegeId?: string; majorId?: string; collegeName?: string; majorName?: string; currentGrade?: number; status: UserStatus; registeredAt?: string; wechatBound: boolean; avatarUrl?: string | null }
const userView = (u: WireUser): ManagedUser => ({ ...u, name: u.nickname, account: u.accountCode, email: u.email ?? '', collegeId: u.collegeId ?? '', majorId: u.majorId ?? '', grade: u.currentGrade, registeredAt: u.registeredAt, wechatBound: u.wechatBound })
const segment = encodeURIComponent

export class HttpAdminContentGateway implements AdminContentGateway {
  readonly mode = 'http' as const
  private pending = new Map<string, string>()
  private provisionalToken = ''
  private imageKeys = new WeakMap<File, string>()
  constructor(private baseUrl = '', private fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private token = () => getAdminSession()?.accessToken ?? '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '')
  }
  private async request<T>(method: string, path: string, body?: unknown, query?: object, key?: string, binary = false): Promise<T> {
    const params = new URLSearchParams()
    Object.entries(query ?? {}).forEach(([name, value]) => { if (value !== undefined && value !== null && value !== '') params.set(name, String(value)) })
    const raw = body instanceof Blob ? body : body === undefined ? undefined : JSON.stringify(body)
    if (typeof raw === 'string' && new TextEncoder().encode(raw).length > 8 * 1024 * 1024) throw new Error('每批请求最多 8 MiB，请拆分文件')
    const headers: Record<string, string> = { 'X-Request-Id': crypto.randomUUID() }
    const identity = this.provisionalToken || this.token()
    const token = path === '/admin/auth/sessions' ? '' : identity
    const checkIdentity = () => { if (identity !== (this.provisionalToken || this.token())) throw new ApiError('账号已切换，请重新操作', 'IDENTITY_CHANGED', 499, headers['X-Request-Id']) }
    if (token) headers.Authorization = `Bearer ${token}`
    if (raw !== undefined) headers['Content-Type'] = body instanceof Blob ? body.type : 'application/json'
    if (key) headers['Idempotency-Key'] = key
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/v1${path}${params.size ? '?' + params : ''}`, { method, headers, body: raw, signal: controller.signal })
      checkIdentity()
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        checkIdentity()
        if (response.status === 401 && !path.startsWith('/admin/auth/')) {
          logout()
          if (typeof window !== 'undefined') window.dispatchEvent(new Event('storage'))
        }
        const retry = response.headers.get('Retry-After')
        const wait = retry ? (/^\d+$/.test(retry) ? Number(retry) : Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000))) : error.details?.retryAfterSeconds
        throw new ApiError(error.message || `请求失败（${response.status}）`, error.code || '', response.status, response.headers.get('X-Request-Id') || headers['X-Request-Id'], Number.isFinite(wait) ? wait : undefined)
      }
      const result = binary ? await response.blob() : response.status === 204 ? undefined : await response.json()
      checkIdentity()
      return result as T
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new Error(controller.signal.aborted ? '请求超时，可使用原内容重试' : error instanceof Error ? error.message : '网络请求失败')
    } finally { clearTimeout(timeout) }
  }
  private async page<T>(path: string, query?: object): Promise<Page<T>> {
    const data = await this.request<Page<T>>('GET', path, undefined, { page: 1, pageSize: 20, ...query })
    if (!Array.isArray(data.items) || !Number.isInteger(data.total) || !Number.isInteger(data.page) || !Number.isInteger(data.pageSize)) throw new Error('列表读取失败，请稍后重试')
    return data
  }
  private async write<T = Mutation>(method: string, path: string, body?: unknown, query?: object, originalKey?: string): Promise<T> {
    const fingerprint = JSON.stringify([this.token(), method, path, body, query])
    const key = originalKey || this.pending.get(fingerprint) || crypto.randomUUID()
    this.pending.set(fingerprint, key)
    try {
      const result = await this.request<T>(method, path, body, query, key)
      this.pending.delete(fingerprint)
      return result
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && error.status !== 429) this.pending.delete(fingerprint)
      throw error
    }
  }
  async loginAdmin(username: string, password: string): Promise<AdminLogin> {
    const session = await this.request<{ accessToken: string; expiresAt: string; sessionMinutes: number }>('POST', '/admin/auth/sessions', { username, password, deviceId: crypto.randomUUID() })
    this.provisionalToken = session.accessToken
    try { return { ...session, account: await this.currentAdmin() } } finally { this.provisionalToken = '' }
  }
  currentAdmin() { return this.request<AdminAccount>('GET', '/admin/auth/me') }
  async logoutAdmin() { await this.request('POST', '/admin/auth/logout'); this.pending.clear() }
  listColleges(query?: CollegeQuery) { return this.page<College>('/admin/colleges', query) }
  getCollege(id: string) { return this.request<College>('GET', '/admin/colleges/' + segment(id)) }
  getMajor(id: string) { return this.request<Major>('GET', '/admin/majors/' + segment(id)) }
  getAdminAccount(id: string) { return this.request<AdminAccount>('GET', '/admin/administrators/' + segment(id)) }
  listMajors(query?: MajorQuery) { return this.page<Major>('/admin/majors', query) }
  listSubjects(query?: SubjectQuery) { return this.page<Subject>('/admin/subjects', query) }
  getSubject(id: string) { return this.request<Subject>('GET', '/admin/subjects/' + segment(id)) }
  getDirectorySummary(query?: { collegeId?: string; majorId?: string }) { return this.request<DirectorySummary>('GET', '/admin/directory-summary', undefined, query) }
  async createCollege(input: CreateCollegeInput) { return { ...input, ...await this.write('POST', '/admin/colleges', input), createdAt: '', updatedAt: '' } }
  async updateCollege(id: string, input: UpdateCollegeInput) { return { ...input, ...await this.write('PUT', '/admin/colleges/' + segment(id), input), createdAt: '', updatedAt: '' } }
  async createMajor(input: CreateMajorInput) { return { ...input, ...await this.write('POST', '/admin/majors', input), createdAt: '', updatedAt: '' } }
  async updateMajor(id: string, input: UpdateMajorInput) { return { ...input, ...await this.write('PUT', '/admin/majors/' + segment(id), input), createdAt: '', updatedAt: '' } }
  async createSubject(input: CreateSubjectInput) { return { ...input, ...await this.write('POST', '/admin/subjects', input), createdAt: '', updatedAt: '' } }
  async updateSubject(id: string, input: UpdateSubjectInput) { return { ...input, ...await this.write('PUT', '/admin/subjects/' + segment(id), input), createdAt: '', updatedAt: '' } }
  listSubjectAccess(id: string, query?: PageQuery) { return this.page<SubjectAccess>(`/admin/subjects/${segment(id)}/user-access`, query) }
  async grantSubjectAccess(id: string, userId: string, expectedVersion: number) { await this.write('POST', `/admin/subjects/${segment(id)}/user-access`, { userId, expectedVersion }) }
  async revokeSubjectAccess(id: string, userId: string, expectedVersion: number) { await this.write('DELETE', `/admin/subjects/${segment(id)}/user-access/${segment(userId)}`, undefined, { expectedVersion }) }
  listQuestionBanks(query?: QuestionBankQuery) { return this.page<QuestionBank>('/admin/question-banks', query) }
  getQuestionBank(id: string) { return this.request<QuestionBank>('GET', '/admin/question-banks/' + segment(id)) }
  async createQuestionBank(input: CreateQuestionBankInput) { const result = await this.write('POST', '/admin/question-banks', input); return this.getQuestionBank(result.id) }
  async updateQuestionBank(id: string, input: UpdateQuestionBankInput) { await this.write('PUT', '/admin/question-banks/' + segment(id), input); return this.getQuestionBank(id) }
  async setBankPublication(id: string, status: BankPublicationStatus, expectedVersion: number) { await this.write('PUT', `/admin/question-banks/${segment(id)}/publication`, { status, expectedVersion }); return this.getQuestionBank(id) }
  publicationChecks(id: string) { return this.request<PublicationCheck[]>('GET', `/admin/question-banks/${segment(id)}/publication-checks`) }
  listChapters(id: string) { return this.request<Chapter[]>('GET', `/admin/question-banks/${segment(id)}/chapters`) }
  async saveChapter(id: string | undefined, input: Pick<Chapter, 'questionBankId' | 'name' | 'sortOrder'> & { expectedVersion?: number }) {
    const { questionBankId, ...body } = input
    const result = await this.write(id ? 'PUT' : 'POST', `/admin/question-banks/${segment(questionBankId)}/chapters${id ? '/' + segment(id) : ''}`, body)
    return { ...input, ...result }
  }
  async deleteChapter(chapter: Chapter) { await this.write('DELETE', `/admin/question-banks/${segment(chapter.questionBankId)}/chapters/${segment(chapter.id)}`, undefined, { expectedVersion: chapter.version }) }
  async reorderChapters(id: string, ids: string[], expectedContentVersion: number) { await this.write('PUT', `/admin/question-banks/${segment(id)}/chapter-order`, { ids, expectedContentVersion }) }
  async listQuestions(query: QuestionQuery & { questionBankId: string }) {
    const { questionBankId, ...params } = query
    const result = await this.page<Question>(`/admin/question-banks/${segment(questionBankId)}/questions`, params)
    return { ...result, items: result.items.map(questionFromWire) }
  }
  async getQuestion(id: string) { return questionFromWire(await this.request<Question>('GET', '/admin/questions/' + segment(id))) }
  async createQuestion(input: CreateQuestionInput) { const result = await this.write('POST', '/admin/questions', questionToWire(input)); return this.getQuestion(result.id) }
  async updateQuestion(id: string, input: UpdateQuestionInput) { await this.write('PUT', '/admin/questions/' + segment(id), questionToWire(input)); return this.getQuestion(id) }
  async deactivateQuestion(id: string, expectedVersion: number) { await this.write('DELETE', '/admin/questions/' + segment(id), undefined, { expectedVersion }) }
  async previewImport(input: ImportQuestionsInput) {
    const result = await this.request<{ valid: boolean; questionCount: number; issues: { message: string }[] }>('POST', `/admin/question-banks/${segment(input.questionBankId)}/import-preview`, importBody(input))
    if (!result.valid) throw new Error(result.issues.map(item => item.message).join('；'))
    return { acceptedCount: result.questionCount }
  }
  async importQuestions(input: ImportQuestionsInput) { await this.write('POST', `/admin/question-banks/${segment(input.questionBankId)}/imports`, importBody(input), undefined, input.idempotencyKey); return countQuestions(input.questions) }
  getDashboardSummary() { return this.request<DashboardSummary>('GET', '/admin/dashboard') }
  getActivity(query: ActivityQuery) { return this.request<ActivitySummary>('GET', '/admin/statistics/activity', undefined, query) }
  getRankings(query: ActivityQuery) { return this.page<RankingRow>('/admin/statistics/rankings', query) }
  getOnlineUsers(query: OnlineQuery) { return this.request<OnlineUsers>('GET', '/admin/statistics/online-users', undefined, { page: 1, pageSize: 20, ...query }) }
  getSystemHealth() { return this.request<SystemHealth>('GET', '/admin/monitoring/health') }
  getDeadLetterHead() { return this.request<import('../types/monitoring').DeadLetterHead>('GET', '/admin/sync/dead-letters/head') }
  replaySyncCommand(commandId: string) { return this.write('POST', `/admin/sync/dead-letters/${segment(commandId)}/replay`) }
  watchSyncHealth(onSnapshot: (data: SyncSnapshot) => void, onStatus: (status: StreamStatus) => void) {
    return watchSyncStream(this.fetcher, this.baseUrl + '/api/v1/admin/monitoring/sync/stream', this.token, onSnapshot, status => {
      if (status === 'AUTH_EXPIRED') { logout(); if (typeof window !== 'undefined') window.dispatchEvent(new Event('storage')) }
      onStatus(status)
    })
  }
  listTestAccounts(query: TestAccountQuery) { return this.page<TestAccount>('/admin/test-accounts', query) }
  createTestAccount(input: TestAccountInput) { return this.write<TestAccount>('POST', '/admin/test-accounts', input) }
  getTestAccountCredentials(id: string) { return this.request<TestAccountCredentials>('GET', `/admin/test-accounts/${segment(id)}/credentials`) }
  async disableTestAccount(id: string, expectedVersion: number) { await this.write('PUT', `/admin/test-accounts/${segment(id)}/status`, { expectedVersion }) }
  async listUsers(query?: UserQuery) { const result = await this.page<WireUser>('/admin/users', query); return { ...result, items: result.items.map(userView) } }
  async getUser(id: string) { return userView(await this.request<WireUser>('GET', '/admin/users/' + segment(id))) }
  async updateUserProfile(id: string, input: UpdateManagedUserInput) { await this.write('PUT', '/admin/users/' + segment(id), input) }
  getUserStatistics(id: string) { return this.request<{ answeredCount: number; correctCount: number; durationSeconds: number }>('GET', `/admin/students/${segment(id)}/statistics`, undefined, { period: 'ALL' }) }
  async setUserStatus(id: string, status: UserStatus, expectedVersion: number) { await this.write('PUT', `/admin/users/${segment(id)}/status`, { status, expectedVersion }) }
  listAdminAccounts(query?: PageQuery) { return this.page<AdminAccount>('/admin/administrators', query) }
  async saveAdminAccount(id: string | undefined, input: AdminAccountInput) {
    const result = await this.write(id ? 'PUT' : 'POST', '/admin/administrators' + (id ? '/' + segment(id) : ''), input)
    return { id: result.id, version: result.version, username: input.username.trim().toLowerCase(), name: input.name.trim().normalize('NFC'), status: input.status ?? 'ACTIVE', role: 'SUPER_ADMIN' as const, createdAt: '' }
  }
  async disableAdminAccount(id: string, expectedVersion: number) { await this.write('DELETE', '/admin/administrators/' + segment(id), undefined, { expectedVersion }) }
  listAnnouncements(query?: PageQuery) { return this.page<Announcement>('/admin/announcements', query) }
  async saveAnnouncement(id: string | undefined, input: AnnouncementInput) { const result = await this.write(id ? 'PUT' : 'POST', '/admin/announcements' + (id ? '/' + segment(id) : ''), input); return { ...input, ...result, updatedAt: new Date().toISOString() } }
  async deleteAnnouncement(id: string, expectedVersion: number) { await this.write('DELETE', '/admin/announcements/' + segment(id), undefined, { expectedVersion }) }
  async listFeedback(query: PageQuery & { kind: StudentFeedback['kind']; status?: string }) {
    const { kind, ...params } = query
    const data = await this.page<StudentFeedback & { courseName?: string; question?: Question }>(kind === 'QUESTION' ? '/admin/question-feedback' : '/admin/course-requests', params)
    return { ...data, items: data.items.map(row => ({ ...row, kind, title: row.courseName ?? row.question?.stem ?? '', questionId: row.question?.id, questionBankId: row.question?.questionBankId, questionSnapshot: row.question ? questionFromWire(row.question) : undefined, questionRevision: row.question?.revision })) }
  }
  async updateFeedback(feedback: StudentFeedback, input: Pick<StudentFeedback, 'status' | 'response'>) { await this.write('PUT', `/admin/${feedback.kind === 'QUESTION' ? 'question-feedback' : 'course-requests'}/${segment(feedback.id)}`, { ...input, expectedVersion: feedback.version }) }
  getSecuritySettings() { return this.request<SecuritySettings>('GET', '/admin/security-policy') }
  saveSecuritySettings(input: SecuritySettings) { const { version, updatedAt: _at, ...body } = input; return this.write<SecuritySettings>('PUT', '/admin/security-policy', { ...body, expectedVersion: version }) }
  getCommunityGroup() { return this.request<import('../types/operations').CommunityGroup>('GET', '/admin/community/group') }
  saveCommunityGroup(input: { expectedVersion: number; image: string; expiresAt: string }) { return this.write<import('../types/operations').CommunityGroup>('PUT', '/admin/community/group', input) }
  communityGroupImage(version: number) { return `${this.baseUrl}/api/v1/community/group/image?v=${version}` }
  async listOperationLogs(query?: LogQuery) {
    const data = await this.page<{ id: string; createdAt: string; actorAdminId?: string; actorUserId?: string; operation: string; outcome: 'SUCCESS' | 'FAILURE'; reasonCode?: string; requestId: string }>('/admin/audit-logs', query)
    return { ...data, items: data.items.map(row => ({ id: row.id, createdAt: row.createdAt, actor: row.actorAdminId || row.actorUserId || '系统', module: row.operation, content: [row.reasonCode, row.requestId].filter(Boolean).join(' · '), result: row.outcome, ip: '' } satisfies OperationLog)) }
  }
  uploadImage(bankId: string, file: File) {
    const key = this.imageKeys.get(file) || crypto.randomUUID()
    this.imageKeys.set(file, key)
    return this.request<{ id: string }>('POST', `/admin/question-banks/${segment(bankId)}/images`, file, undefined, key)
  }
  async imageUrl(id: string) { return URL.createObjectURL(await this.request<Blob>('GET', '/files/' + segment(id), undefined, undefined, undefined, true)) }

}
