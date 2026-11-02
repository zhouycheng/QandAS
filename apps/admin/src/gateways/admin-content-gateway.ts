import type { BankPublicationStatus, Chapter, College, CollegeQuery, CreateCollegeInput, CreateMajorInput, CreateQuestionBankInput, CreateQuestionInput, CreateSubjectInput, DashboardSummary, DirectorySummary, Major, MajorQuery, Page, PageQuery, PublicationCheck, Question, QuestionBank, QuestionBankQuery, QuestionQuery, Subject, SubjectQuery, UpdateCollegeInput, UpdateMajorInput, UpdateQuestionBankInput, UpdateQuestionInput, UpdateSubjectInput } from '../types/admin'
import type { StudentFeedback, UserStatus, ActivityQuery, ActivitySummary, RankingRow, SubjectAccess, AdminAccount, AdminAccountInput, AdminLogin, Announcement, AnnouncementInput, ImportQuestionsInput, LogQuery, ManagedUser, OperationLog, SecuritySettings, UserQuery } from '../types/operations'

import type { OnlineQuery, OnlineUsers, SyncSnapshot, SystemHealth, StreamStatus } from '../types/monitoring'
import type { CommunityGroup } from '../types/operations'

export interface AdminContentGateway {
  readonly mode: 'mock' | 'http'
  loginAdmin(username: string, password: string): Promise<AdminLogin>
  currentAdmin(): Promise<AdminAccount>
  logoutAdmin(): Promise<void>
  listChapters(questionBankId: string): Promise<Chapter[]>
  saveChapter(id: string | undefined, input: Pick<Chapter, 'questionBankId' | 'name' | 'sortOrder'> & { expectedVersion?: number }): Promise<Chapter>
  deleteChapter(chapter: Chapter): Promise<void>
  reorderChapters(questionBankId: string, ids: string[], expectedContentVersion: number): Promise<void>
  setBankPublication(id: string, status: BankPublicationStatus, expectedVersion: number): Promise<QuestionBank>
  publicationChecks(id: string): Promise<PublicationCheck[]>
  listFeedback(query: PageQuery & { kind: StudentFeedback['kind']; status?: string }): Promise<Page<StudentFeedback>>
  updateFeedback(feedback: StudentFeedback, input: Pick<StudentFeedback, 'status' | 'response'>): Promise<void>
  setUserStatus(id: string, status: UserStatus, expectedVersion: number): Promise<void>
  listUsers(query?: UserQuery): Promise<Page<ManagedUser>>
  getUser(id: string): Promise<ManagedUser>
  getUserStatistics(id: string): Promise<{ answeredCount: number; correctCount: number; durationSeconds: number }>
  listAdminAccounts(query?: PageQuery): Promise<Page<AdminAccount>>
  saveAdminAccount(id: string | undefined, input: AdminAccountInput): Promise<AdminAccount>
  disableAdminAccount(id: string, expectedVersion: number): Promise<void>
  listAnnouncements(query?: PageQuery): Promise<Page<Announcement>>
  saveAnnouncement(id: string | undefined, input: AnnouncementInput): Promise<Announcement>
  deleteAnnouncement(id: string, expectedVersion: number): Promise<void>
  getSecuritySettings(): Promise<SecuritySettings>
  saveSecuritySettings(input: SecuritySettings): Promise<SecuritySettings>
  getCommunityGroup(): Promise<CommunityGroup>
  saveCommunityGroup(input: { expectedVersion: number; image: string; expiresAt: string }): Promise<CommunityGroup>
  communityGroupImage(version: number): string
  listOperationLogs(query?: LogQuery): Promise<Page<OperationLog>>
  getActivity(query: ActivityQuery): Promise<ActivitySummary>
  getRankings(query: ActivityQuery): Promise<Page<RankingRow>>
  getOnlineUsers(query: OnlineQuery): Promise<OnlineUsers>
  getSystemHealth(): Promise<SystemHealth>
  getDeadLetterHead(): Promise<import('../types/monitoring').DeadLetterHead>
  replaySyncCommand(commandId: string): Promise<unknown>
  watchSyncHealth(onSnapshot: (data: SyncSnapshot) => void, onStatus: (status: StreamStatus) => void): () => void
  importQuestions(input: ImportQuestionsInput): Promise<number>
  previewImport(input: ImportQuestionsInput): Promise<{ acceptedCount: number }>
  getDashboardSummary(): Promise<DashboardSummary>
  getDirectorySummary(query?: { collegeId?: string; majorId?: string }): Promise<DirectorySummary>
  listSubjectAccess(id: string, query?: PageQuery): Promise<Page<SubjectAccess>>
  grantSubjectAccess(id: string, userId: string, expectedVersion: number): Promise<void>
  revokeSubjectAccess(id: string, userId: string, expectedVersion: number): Promise<void>
  uploadImage(bankId: string, file: File): Promise<{ id: string }>
  imageUrl(id: string): Promise<string>
  listColleges(query?: CollegeQuery): Promise<Page<College>>
  getCollege(id: string): Promise<College>
  getMajor(id: string): Promise<Major>
  getAdminAccount(id: string): Promise<AdminAccount>
  createCollege(input: CreateCollegeInput): Promise<College>
  updateCollege(id: string, input: UpdateCollegeInput): Promise<College>
  listMajors(query?: MajorQuery): Promise<Page<Major>>
  createMajor(input: CreateMajorInput): Promise<Major>
  updateMajor(id: string, input: UpdateMajorInput): Promise<Major>
  listSubjects(query?: SubjectQuery): Promise<Page<Subject>>
  getSubject(id: string): Promise<Subject>
  createSubject(input: CreateSubjectInput): Promise<Subject>
  updateSubject(id: string, input: UpdateSubjectInput): Promise<Subject>
  listQuestionBanks(query?: QuestionBankQuery): Promise<Page<QuestionBank>>
  getQuestionBank(id: string): Promise<QuestionBank>
  createQuestionBank(input: CreateQuestionBankInput): Promise<QuestionBank>
  updateQuestionBank(id: string, input: UpdateQuestionBankInput): Promise<QuestionBank>
  listQuestions(query: QuestionQuery & { questionBankId: string }): Promise<Page<Question>>
  getQuestion(id: string): Promise<Question>
  createQuestion(input: CreateQuestionInput): Promise<Question>
  updateQuestion(id: string, input: UpdateQuestionInput): Promise<Question>
  deactivateQuestion(id: string, expectedVersion: number): Promise<void>
}
