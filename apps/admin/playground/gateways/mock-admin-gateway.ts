import type { AdminContentGateway } from '../../src/gateways/admin-content-gateway'
import type {
  BankPublicationStatus,
  Chapter,
  CreateQuestionBankInput as BankInput,
  CollegeQuery,
  CreateCollegeInput,
  CreateMajorInput,
  CreateQuestionBankInput,
  CreateQuestionInput,
  CreateSubjectInput,
  MajorQuery,
  QuestionBankQuery,
  QuestionQuery,
  SubjectQuery,
  UpdateCollegeInput,
  UpdateMajorInput,
  UpdateQuestionBankInput,
  UpdateQuestionInput,
  UpdateSubjectInput,
} from '../../src/types/admin'
import { getMockAdminState } from '../store/mock-admin-store'
import type {
  StudentFeedback,
  UserStatus,
  ActivityQuery,
  AdminAccountInput,
  AnnouncementInput,
  ImportQuestionsInput,
  LogQuery,
  SecuritySettings,
  UserQuery,
} from '../../src/types/operations'
import { hashPassword, validateQuestion } from '../../src/lib/content-rules'
import { getAdminSession, isAuthenticated } from '../../src/lib/auth'
import { localDate } from '../../src/lib/format'
import { getScopeError, publicationChecks } from '../../src/lib/bank-workbench'
import { contentFingerprint, countQuestions, missingExplanations, questionSearchText } from '../../src/lib/question-content'

import type { Page, PageQuery, QuestionBank, Question, Versioned } from '../../src/types/admin'
import { ApiError } from '../../src/gateways/api-error'
import { importBody } from '../../src/gateways/question-wire'

const DEFAULT_DELAY = 30
function paged<T>(items: T[], query: PageQuery = {}): Page<T> {
  const { page = 1, pageSize = 20 } = query
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ApiError('分页参数无效。')
  return structuredClone({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize })
}
function version(current: Versioned | undefined, expected: number | undefined) {
  if (!current) throw new ApiError('记录不存在。', 'NOT_FOUND', 404)
  if (current.version !== expected) throw new ApiError('内容已更新，请刷新后重试。', 'VERSION_CONFLICT', 409)
}
function bumpBank(id: string) {
  const state = getMockAdminState()
  state.setQuestionBanks(state.questionBanks.map(b => b.id === id ? { ...b, contentVersion: b.contentVersion + 1, version: b.version + 1 } : b))
}
function dateOffset(date: string, days: number) { return new Date(Date.parse(date + 'T00:00:00+08:00') + days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) }
function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) }

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

  function platformOnly() { if (getAdminSession()?.role !== 'PLATFORM_ADMIN') throw new ApiError('需要平台管理员权限。', 'FORBIDDEN', 403) }

async function simulateRequest(operation: 'read' | 'write' = 'read', anonymous = false) {
  const token = getAdminSession()?.accessToken
  if (!anonymous && !isAuthenticated()) throw new ApiError('请重新登录。', 'UNAUTHENTICATED', 401)
  const { scenario, scenarioRevision } = getMockAdminState()
  const delay = scenario === 'slow' ? 3000 : DEFAULT_DELAY
  await new Promise((resolve) => window.setTimeout(resolve, delay))
  if (!anonymous && token !== getAdminSession()?.accessToken) throw new ApiError('账号已切换，请重试。', 'IDENTITY_CHANGED', 499)
  if (getMockAdminState().scenario !== scenario || getMockAdminState().scenarioRevision !== scenarioRevision)
    throw new ApiError('演示场景已切换，请重试。')
  if (scenario === 'error' || (scenario === 'write-error' && operation === 'write')) {
    throw new ApiError('Playground 已模拟服务异常，请切换场景后重试。', 'TEMPORARILY_UNAVAILABLE', 503)
  }
}

function normalize(value?: string) {
  return value?.trim().toLocaleLowerCase() ?? ''
}

export function recordOperation(module: string, content: string, result: 'SUCCESS' | 'FAILURE' = 'SUCCESS') {
  const state = getMockAdminState()
  state.setOperations({
    operationLogs: [
      {
        id: createId('log'),
        createdAt: new Date().toISOString(),
        actor: getAdminSession()?.username ?? 'admin',
        module,
        content,
        result,
        ip: '本地演示',
      },
      ...state.operationLogs,
    ].slice(0, 1000),
  })
}

function publicAccount(account: import('../../src/types/operations').StoredAdminAccount) {
  const { passwordHash: _passwordHash, ...publicFields } = account
  return publicFields
}

export class MockAdminContentGateway implements AdminContentGateway {
  readonly mode = 'mock' as const
  async getSubject(id: string) { await simulateRequest(); const subject = getMockAdminState().subjects.find(s => s.id === id); if (!subject) throw new ApiError('课程不存在。', 'NOT_FOUND', 404); return structuredClone(subject) }
  private imports = new Map<string, { body: string; count: number }>()
  private images = new Map<string, Blob>()
  private bank(id: string) {
    const bank = getMockAdminState().questionBanks.find(b => b.id === id)
    if (!bank) throw new ApiError('题库不存在。', 'NOT_FOUND', 404)
    const actor = getAdminSession()
    if (actor?.role === 'CONTENT_ADMIN' && !bank.maintainerIds.includes(actor.id)) throw new ApiError('该题库未分配给当前管理员。', 'FORBIDDEN', 403)
    return bank
  }
  async currentAdmin() {
    await simulateRequest()
    const account = getMockAdminState().adminAccounts.find(a => a.id === getAdminSession()?.id && a.status === 'ACTIVE')
    if (!account) throw new ApiError('请重新登录。')
    return publicAccount(account)
  }
  async logoutAdmin() { await simulateRequest('write'); window.localStorage.removeItem('qanda-admin-auth') }
  async getQuestionBank(id: string) { await simulateRequest(); return structuredClone(this.bankFacts(this.bank(id))) }
  private bankFacts(bank: QuestionBank) {
    const questions = getMockAdminState().questions.filter(q => q.questionBankId === bank.id)
    return { ...bank, questionCount: countQuestions(questions), activeQuestionCount: countQuestions(questions.filter(q => q.status === 'ACTIVE')) }
  }
  async publicationChecks(id: string) {
    await simulateRequest()
    const bank = this.bank(id), state = getMockAdminState()
    return publicationChecks(bank, state.subjects.find(s => s.id === bank.subjectId), state.questions.filter(q => q.questionBankId === id), state)
  }
  private validateQuestionPlacement(input: CreateQuestionInput) {
    this.bank(input.questionBankId)
    if (
      getMockAdminState().questionBanks.some(
        (b) => b.id === input.questionBankId && b.publicationStatus === 'PUBLISHED',
      ) &&
      input.status === 'ACTIVE' &&
      missingExplanations([input]) > 0
    )
      throw new ApiError('已发布题库中的启用题目必须有解析。可先下架题库整理。')
    if (
      input.chapterId &&
      !getMockAdminState().chapters.some(
        (c) => c.id === input.chapterId && c.questionBankId === input.questionBankId,
      )
    )
      throw new ApiError('章节不存在或不属于当前题库。')
  }

  private validateBank(input: BankInput, requireScope = false) {
    const state = getMockAdminState()
    if (!['ACTIVE', 'INACTIVE'].includes(input.status)) throw new ApiError('内容状态无效。')
    if (!input.name.trim() || input.name.trim().length > 80 || (input.description?.length ?? 0) > 2000)
      throw new ApiError('题库名称必填且最多 80 字，说明最多 2000 字。')
    if ((input.textbook?.length ?? 0) > 120) throw new ApiError('教材说明最多 120 字。')
    if ((input.maintainerIds ?? []).some(id => !state.adminAccounts.some(a => a.id === id && a.status === 'ACTIVE'))) throw new ApiError('请选择启用的管理员作为维护者。')
    const scopeType = input.scopeType ?? 'ALL'
    if (!['ALL', 'TARGETED'].includes(scopeType)) throw new ApiError('适用范围类型无效。')
    const audiences = scopeType === 'ALL' ? [] : structuredClone(input.audiences ?? [])
    const scopeError = getScopeError(scopeType, audiences, state, requireScope)
    if (scopeError) throw new ApiError(scopeError)
    return {
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      textbook: input.textbook?.trim() ?? '',
      maintainerIds: [...new Set(input.maintainerIds ?? [])],
      scopeType,
      audiences,
    }
  }

  async setUserStatus(id: string, status: UserStatus, expectedVersion: number) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    const user = state.users.find((u) => u.id === id)
    if (!user) throw new ApiError('用户不存在。', 'NOT_FOUND', 404)
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw new ApiError('账号状态无效。')
    version(user, expectedVersion)
    const updated = { ...user, status, version: user.version + 1 }
    state.setOperations({ users: state.users.map((u) => (u.id === id ? updated : u)) })
    recordOperation('用户管理', `${status === 'ACTIVE' ? '恢复' : '停用'}账号：${user.account}`)
  }

  async listFeedback(query: PageQuery & { kind: StudentFeedback['kind']; status?: string }) {
    await simulateRequest()
    const actor = getAdminSession()
    if (query.kind === 'COURSE_REQUEST') platformOnly()
    return paged(getMockAdminState().feedback.filter(f => f.kind === query.kind && (!query.status || f.status === query.status) &&
      (actor?.role !== 'CONTENT_ADMIN' || getMockAdminState().questionBanks.some(b => b.id === f.questionBankId && b.maintainerIds.includes(actor.id)))).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), query)
  }

  async updateFeedback(feedback: StudentFeedback, input: Pick<StudentFeedback, 'status' | 'response'>) {
    await simulateRequest('write')
    const state = getMockAdminState()
    if (feedback.kind === 'COURSE_REQUEST') platformOnly()
    else if (feedback.questionBankId) this.bank(feedback.questionBankId)
    const id = feedback.id
    const current = state.feedback.find((f) => f.id === id)
    version(current, feedback.version)
    if (!current) throw new ApiError('反馈不存在。', 'NOT_FOUND', 404)
    if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED'].includes(input.status))
      throw new ApiError('反馈状态无效。')
    if (typeof input.response !== 'string' || input.response.length > 2000)
      throw new ApiError('处理说明最多 2000 字。')
    if (['RESOLVED', 'DISMISSED'].includes(input.status) && !input.response.trim())
      throw new ApiError('结束处理前请填写给学生的回复。')
    const updated = {
      ...current,
      version: current.version + 1,
      status: input.status,
      response: input.response.trim(),
      updatedAt: new Date().toISOString(),
    }
    state.setOperations({ feedback: state.feedback.map((f) => (f.id === id ? updated : f)) })
    recordOperation(
      '学生反馈',
      `处理${current.kind === 'QUESTION' ? '题目纠错' : '缺课需求'}：${current.title}`,
    )
  }

  async listChapters(questionBankId: string) {
    await simulateRequest()
    return structuredClone(
      getMockAdminState().chapters.filter((c) => !questionBankId || c.questionBankId === questionBankId),
    ).map(c => ({ ...c, questionCount: countQuestions(getMockAdminState().questions.filter(q => q.chapterId === c.id)) })).sort((a, b) => a.sortOrder - b.sortOrder)
  }

  async saveChapter(id: string | undefined, input: Pick<Chapter, 'questionBankId' | 'name' | 'sortOrder'> & { expectedVersion?: number }) {
    await simulateRequest('write')
    const state = getMockAdminState()
    const current = state.chapters.find((c) => c.id === id)
    if (id) version(current, input.expectedVersion)
    this.bank(input.questionBankId)
    if (!state.questionBanks.some((b) => b.id === input.questionBankId)) throw new ApiError('题库不存在。', 'NOT_FOUND', 404)
    if (current && current.questionBankId !== input.questionBankId)
      throw new ApiError('章节不能迁移至其他题库。')
    if (!input.name.trim() || input.name.length > 60) throw new ApiError('章节名称必填且最多 60 字。')
    if (
      state.chapters.some(
        (c) => c.id !== id && c.questionBankId === input.questionBankId && c.name === input.name.trim(),
      )
    )
      throw new ApiError('题库内已有同名章节。')
    const chapter = {
      ...input,
      name: input.name.trim(),
      version: (current?.version ?? 0) + 1,
      id: id ?? createId('chapter'),
      sortOrder:
        current?.sortOrder ?? state.chapters.filter((c) => c.questionBankId === input.questionBankId).length,
    }
    state.setOperations({
      chapters: current
        ? state.chapters.map((c) => (c.id === id ? chapter : c))
        : [...state.chapters, chapter],
    })
    bumpBank(input.questionBankId)
    recordOperation('章节管理', `保存章节：${chapter.name}`)
    return chapter
  }

  async reorderChapters(questionBankId: string, ids: string[], expectedContentVersion: number) {
    await simulateRequest('write')
    const state = getMockAdminState()
    if (this.bank(questionBankId).contentVersion !== expectedContentVersion) throw new ApiError('题库内容已更新，请刷新。', 'VERSION_CONFLICT', 409)
    const chapters = state.chapters.filter((c) => c.questionBankId === questionBankId)
    if (
      ids.length !== chapters.length ||
      new Set(ids).size !== ids.length ||
      chapters.some((c) => !ids.includes(c.id))
    )
      throw new ApiError('章节顺序无效，请刷新重试。')
    state.setOperations({
      chapters: state.chapters.map((c) =>
        c.questionBankId === questionBankId ? { ...c, sortOrder: ids.indexOf(c.id), version: c.version + 1 } : c,
      ),
    })
    bumpBank(questionBankId)
    recordOperation('章节管理', '调整章节顺序')
  }

  async deleteChapter(chapter: Chapter) {
    const id = chapter.id
    await simulateRequest('write')
    const state = getMockAdminState()
    version(state.chapters.find(c => c.id === id), chapter.version)
    this.bank(chapter.questionBankId)
    if (state.questions.some((q) => q.chapterId === id))
      throw new ApiError('章节仍有题目，请先移动题目或设为未分章。')
    state.setOperations({ chapters: state.chapters.filter((c) => c.id !== id) })
    bumpBank(chapter.questionBankId)
    recordOperation('章节管理', '删除空章节')
  }

  async setBankPublication(id: string, status: BankPublicationStatus, expectedVersion: number) {
    await simulateRequest('write')
    const state = getMockAdminState()
    const current = this.bank(id)
    version(current, expectedVersion)
    if (!current) throw new ApiError('题库不存在。', 'NOT_FOUND', 404)
    if (!['DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED'].includes(status)) throw new ApiError('发布状态无效。')
    if (status === 'PUBLISHED') {
      if (!state.subjects.some((s) => s.id === current.subjectId && s.status === 'ACTIVE'))
        throw new ApiError('请先启用所属课程。')
      this.validateBank(current, true)
      const questions = state.questions.filter((q) => q.questionBankId === id && q.status === 'ACTIVE')
      if (!questions.length) throw new ApiError('题库至少需要一道启用的题目才能发布。')
      for (const q of questions) {
        validateQuestion(q)
        this.validateQuestionPlacement(q)
      }
      if (missingExplanations(questions)) throw new ApiError('发布前请补全所有启用题目及阅读小题的解析。')
      if (!current.description.trim()) throw new ApiError('发布前请填写题库说明，帮助学生选择。')
    }
    const updated = {
      ...current,
      version: current.version + 1,
      contentVersion: current.contentVersion + 1,
      publicationStatus: status,
      updatedAt: new Date().toISOString(),
    }
    state.setQuestionBanks(state.questionBanks.map((b) => (b.id === id ? updated : b)))
    recordOperation('题库发布', `${status}：${current.name}`)
    return updated
  }

  async listUsers(query?: UserQuery) {
    await simulateRequest(); platformOnly()
    const state = getMockAdminState()
    return paged(state.users.filter(
      (u) =>
        normalize(`${u.name} ${u.account} ${u.email}`).includes(normalize(query?.keyword)) &&
        (!query?.collegeId || u.collegeId === query.collegeId) &&
        (!query?.majorId || u.majorId === query.majorId) &&
        (!query?.status || u.status === query.status) && (!query?.grade || u.grade === query.grade),
    ).map(user => ({ ...user, collegeName: state.colleges.find(c => c.id === user.collegeId)?.name, majorName: state.majors.find(m => m.id === user.majorId)?.name })), query)
  }

  async listAdminAccounts(query?: PageQuery) {
    await simulateRequest(); platformOnly()
    return paged(getMockAdminState().adminAccounts.map(publicAccount), query)
  }

  async saveAdminAccount(id: string | undefined, input: AdminAccountInput) {
    await simulateRequest('write'); platformOnly()
    const security = getMockAdminState().security
    if (!input.name.trim() || input.name.length > 40 || !/^[A-Za-z0-9_-]{3,30}$/.test(input.username))
      throw new ApiError('姓名必填，登录账号须为 3 至 30 位字母、数字、短横线或下划线。')
    if (!['ACTIVE', 'DISABLED'].includes(input.status)) throw new ApiError('管理员状态无效。')
    if (!['PLATFORM_ADMIN', 'CONTENT_ADMIN'].includes(input.role)) throw new ApiError('管理员角色无效。')
    if (!id && !input.password) throw new ApiError('请设置初始密码。')
    if (
      input.password &&
      (input.password.length < security.minPasswordLength ||
        (security.requireLetter && !/[A-Za-z]/.test(input.password)) ||
        (security.requireNumber && !/\d/.test(input.password)) ||
        (security.requireMixedCase && (!/[A-Z]/.test(input.password) || !/[a-z]/.test(input.password))))
    )
      throw new ApiError(`密码至少 ${security.minPasswordLength} 位，并满足已配置的字母、数字及大小写要求。`)
    const passwordHash = input.password ? await hashPassword(input.password) : undefined
    const state = getMockAdminState()
    const current = state.adminAccounts.find((a) => a.id === id)
    if (id) version(current, input.expectedVersion)
    if (state.adminAccounts.some((a) => a.id !== id && normalize(a.username) === normalize(input.username)))
      throw new ApiError('登录账号已存在。')
    if (id === getAdminSession()?.id && input.status === 'DISABLED') throw new ApiError('不能停用当前登录账号。')
    if ((input.status === 'DISABLED' || input.role !== 'PLATFORM_ADMIN') && current?.role === 'PLATFORM_ADMIN' && !state.adminAccounts.some((a) => a.id !== id && a.status === 'ACTIVE' && a.role === 'PLATFORM_ADMIN'))
      throw new ApiError('至少保留一个启用的管理员。')
    const account = {
      id: current?.id ?? createId('admin'),
      version: (current?.version ?? 0) + 1,
      role: input.role,
      name: input.name.trim(),
      username: input.username,
      status: input.status,
      createdAt: current?.createdAt ?? new Date().toISOString(),
      lastLoginAt: current?.lastLoginAt,
      passwordHash: passwordHash ?? current!.passwordHash,
    }
    state.setOperations({
      adminAccounts: current
        ? state.adminAccounts.map((a) => (a.id === id ? account : a))
        : [account, ...state.adminAccounts],
    })
    recordOperation('管理员账号', `${id ? '编辑' : '新增'}账号：${account.username}`)
    return publicAccount(account)
  }

  async disableAdminAccount(id: string, expectedVersion: number) {
    const current = getMockAdminState().adminAccounts.find(a => a.id === id)
    version(current, expectedVersion)
    await this.saveAdminAccount(id, { ...current!, status: 'DISABLED', expectedVersion })
  }

  async loginAdmin(username: string, password: string) {
    await simulateRequest('read', true)
    const state = getMockAdminState()
    const attemptKey = `qanda-login-attempt:${normalize(username)}`
    let attempt = { count: 0, until: 0 }
    try {
      const saved = JSON.parse(window.localStorage.getItem(attemptKey) ?? 'null')
      if (Number.isFinite(saved?.count) && Number.isFinite(saved?.until)) attempt = saved
    } catch {
      /* A damaged local demo counter starts over. */
    }
    if (state.security.lockEnabled && attempt.until > Date.now())
      throw new ApiError('登录失败次数过多，请在锁定时间结束后重试。')
    const passwordHash = await hashPassword(password)
    const account = getMockAdminState().adminAccounts.find(
      (a) =>
        normalize(a.username) === normalize(username) &&
        a.status === 'ACTIVE' &&
        a.passwordHash === passwordHash,
    )
    if (!account) {
      const count = attempt.until && attempt.until <= Date.now() ? 1 : attempt.count + 1
      window.localStorage.setItem(
        attemptKey,
        JSON.stringify({
          count,
          until:
            state.security.lockEnabled && count >= state.security.maxAttempts
              ? Date.now() + state.security.lockMinutes * 60000
              : 0,
        }),
      )
      recordOperation('安全设置', `账号登录失败：${username.slice(0, 30)}`, 'FAILURE')
      throw new ApiError('账号或密码错误，或账号已停用。')
    }
    window.localStorage.removeItem(attemptKey)
    const updated = { ...account, lastLoginAt: new Date().toISOString() }
    state.setOperations({
      adminAccounts: getMockAdminState().adminAccounts.map((a) => (a.id === account.id ? updated : a)),
    })
    recordOperation('管理员账号', `登录成功：${account.username}`)
    return { account: publicAccount(updated), accessToken: 'mock-' + crypto.randomUUID(), expiresAt: new Date(Date.now() + 86400000).toISOString(), sessionMinutes: state.security.sessionMinutes }
  }

  async listAnnouncements(query?: PageQuery) {
    await simulateRequest(); platformOnly()
    // shortcut: Scheduled publishing is evaluated on reads; use a backend scheduler during HTTP integration.
    return paged(getMockAdminState().announcements.map((a) =>
      a.status === 'SCHEDULED' && a.publishAt && new Date(a.publishAt).getTime() <= Date.now()
        ? { ...a, status: 'PUBLISHED' as const }
        : a,
    ), query)
  }

  async saveAnnouncement(id: string | undefined, input: AnnouncementInput) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    if (id) version(state.announcements.find(a => a.id === id), input.expectedVersion)
    if (!input.title.trim() || input.title.length > 80) throw new ApiError('公告标题必填，且最多 80 字。')
    if (
      !['DRAFT', 'PUBLISHED', 'SCHEDULED'].includes(input.status) ||
      !['ALL', 'SELECTED'].includes(input.audience)
    )
      throw new ApiError('公告状态或发布范围无效。')
    if (input.status !== 'DRAFT' && (!input.summary.trim() || !input.body.trim() || !input.platforms.length))
      throw new ApiError('请填写摘要、正文并选择展示端。')
    if (input.platforms.some((p) => p !== 'MINI_PROGRAM' && p !== 'WEB')) throw new ApiError('展示端无效。')
    if (
      input.audience === 'SELECTED' &&
      ((input.status !== 'DRAFT' && !input.userIds.length) ||
        input.userIds.some((id) => !state.users.some((u) => u.id === id)))
    )
      throw new ApiError('请选择有效的指定用户。')
    if (
      input.status === 'SCHEDULED' &&
      (!input.publishAt ||
        !Number.isFinite(Date.parse(input.publishAt)) ||
        Date.parse(input.publishAt) <= Date.now())
    )
      throw new ApiError('定时发布时间必须晚于当前时间。')
    const announcement = {
      ...input,
      id: id ?? createId('announcement'),
      version: (state.announcements.find(a => a.id === id)?.version ?? 0) + 1,
      title: input.title.trim(),
      userIds: input.audience === 'ALL' ? [] : [...new Set(input.userIds)],
      publishAt:
        input.status === 'PUBLISHED'
          ? new Date().toISOString()
          : input.status === 'SCHEDULED'
            ? input.publishAt
            : undefined,
      updatedAt: new Date().toISOString(),
    }
    state.setOperations({
      announcements: id
        ? state.announcements.map((a) => (a.id === id ? announcement : a))
        : [announcement, ...state.announcements],
    })
    recordOperation(
      '公告',
      `${input.status === 'DRAFT' ? '保存草稿' : input.status === 'SCHEDULED' ? '定时发布' : '发布公告'}：${announcement.title}`,
    )
    return announcement
  }

  async deleteAnnouncement(id: string, expectedVersion: number) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    const announcement = state.announcements.find((a) => a.id === id)
    version(announcement, expectedVersion)
    if (!announcement) throw new ApiError('公告不存在。', 'NOT_FOUND', 404)
    state.setOperations({ announcements: state.announcements.filter((a) => a.id !== id) })
    recordOperation('公告', `删除公告：${announcement.title}`)
  }

  async getSecuritySettings() {
    await simulateRequest(); platformOnly()
    return { ...getMockAdminState().security }
  }

  async saveSecuritySettings(input: SecuritySettings) {
    await simulateRequest('write'); platformOnly()
    version(getMockAdminState().security, input.version)
    if (
      ![input.maxAttempts, input.lockMinutes, input.sessionMinutes, input.minPasswordLength].every(
        Number.isInteger,
      ) ||
      input.maxAttempts < 3 ||
      input.maxAttempts > 10 ||
      input.lockMinutes < 1 ||
      input.lockMinutes > 1440 ||
      input.sessionMinutes < 5 ||
      input.sessionMinutes > 1440 ||
      input.minPasswordLength < 12 ||
      input.minPasswordLength > 64
    )
      throw new ApiError('安全设置数值超出允许范围。')
    const security = { ...input, version: input.version + 1, updatedAt: new Date().toISOString() }
    getMockAdminState().setOperations({ security })
    recordOperation('安全设置', '保存管理员登录与密码规则')
    return security
  }

  async listOperationLogs(query?: LogQuery) {
    await simulateRequest(); platformOnly()
    return paged(getMockAdminState().operationLogs.filter(
      (l) =>
        normalize(`${l.actor} ${l.content}`).includes(normalize(query?.keyword)) &&
        (!query?.module || l.module === query.module) &&
        (!query?.result || l.result === query.result) &&
        (!query?.start || localDate(new Date(l.createdAt)) >= query.start) &&
        (!query?.end || localDate(new Date(l.createdAt)) <= query.end),
    ), query)
  }

  private activityRows(query: ActivityQuery) {
    const state = getMockAdminState()
    const users = state.users.filter(u => (!query.collegeId || u.collegeId === query.collegeId) && (!query.majorId || u.majorId === query.majorId) && (!query.grade || u.grade === query.grade))
    const allowed = new Set(users.map(u => u.id))
    const records = state.activityRecords.filter(r => !query.platform || r.platform === query.platform).map(r => ({ ...r, userIds: r.userIds.filter(id => allowed.has(id)), learning: r.learning.filter(l => allowed.has(l.userId)) }))
    return { users, records }
  }
  async getActivity(query: ActivityQuery) {
    await simulateRequest(); platformOnly()
    const { records, users } = this.activityRows(query), current = today()
    const now = Date.now()
    const online = new Set((getMockAdminState().foregroundSessions || []).filter(s => !s.revoked && Date.parse(s.expiresAt) > now && Date.parse(s.seenAt) > now - 120000 && Date.parse(s.seenAt) <= now && (!query.platform || s.platform === query.platform) && users.some(u => u.id === s.userId && u.status === 'ACTIVE')).map(s => s.userId)).size
    const ids = (days: number) => new Set(records.filter(r => r.date >= dateOffset(current, 1 - days) && r.date <= current).flatMap(r => r.userIds))
    const end = query.periodDate ?? current, length = query.period === 'MONTH' ? 30 : query.period === 'DAY' ? 1 : 7
    const trend = Array.from({ length }, (_, i) => { const date = dateOffset(end, i - length + 1); return { date, activeUsers: new Set(records.filter(r => r.date === date).flatMap(r => r.userIds)).size } })
    return { onlineUsers: online, dailyActive: ids(1).size, weeklyActive: ids(7).size, monthlyActive: ids(30).size, updatedAt: new Date().toISOString(), activeUsers: new Set(records.filter(r => r.date >= trend[0].date && r.date <= end).flatMap(r => r.userIds)).size, retention: 0, records: trend }
  }
  async getRankings(query: ActivityQuery) {
    await simulateRequest(); platformOnly()
    const { users, records } = this.activityRows(query), end = query.periodDate ?? today()
    const start = query.period === 'ALL' ? '0001-01-01' : dateOffset(end, 1 - (query.period === 'DAY' ? 1 : query.period === 'MONTH' ? 30 : 7))
    const selected = records.filter(r => r.date >= start && r.date <= end), state = getMockAdminState()
    const rows = users.map(u => {
      const visits = selected.filter(r => r.userIds.includes(u.id)), learning = selected.flatMap(r => r.learning.filter(l => l.userId === u.id))
      return { userId: u.id, nickname: u.name, accountCode: u.account, collegeName: state.colleges.find(c => c.id === u.collegeId)?.name, majorName: state.majors.find(m => m.id === u.majorId)?.name, currentGrade: u.grade,
        activeDays: new Set(visits.map(r => r.date)).size, answeredCount: learning.reduce((sum, l) => sum + l.answeredCount, 0), correctCount: learning.reduce((sum, l) => sum + l.correctCount, 0), durationSeconds: learning.reduce((sum, l) => sum + l.durationSeconds, 0),
        lastActiveAt: visits.length ? new Date(Math.min(Date.now(), Date.parse([...visits].sort((a,b) => b.date.localeCompare(a.date))[0].date + 'T20:00:00+08:00'))).toISOString() : undefined }
    }).filter(r => r.activeDays || r.answeredCount).sort((a,b) => (query.sort === 'ANSWERED_COUNT' ? b.answeredCount - a.answeredCount || b.activeDays - a.activeDays : query.sort === 'DURATION' ? b.durationSeconds - a.durationSeconds || b.answeredCount - a.answeredCount : b.activeDays - a.activeDays || b.answeredCount - a.answeredCount) || a.userId.localeCompare(b.userId))
    return paged(rows.map((row, i) => ({ ...row, rank: i + 1 })), query)
  }
  private validateImport(input: ImportQuestionsInput) {
    const bank = this.bank(input.questionBankId)
    if (bank.contentVersion !== input.expectedContentVersion) throw new ApiError('题库内容已更新，请重新预览。', 'VERSION_CONFLICT', 409)
    if (!input.questions.length || countQuestions(input.questions) > 3000) throw new ApiError('每批最多 3000 道实际作答题。')
    if (new TextEncoder().encode(JSON.stringify(importBody(input))).length > 8 * 1024 * 1024) throw new ApiError('每批请求最多 8 MiB。')
    input.questions.forEach((q, index) => { try { validateQuestion(q); this.validateQuestionPlacement({ ...q, questionBankId: input.questionBankId }) } catch (error) { throw new ApiError(`第 ${index + 1} 题：${(error as Error).message}`) } })
  }
  async previewImport(input: ImportQuestionsInput) { await simulateRequest(); this.validateImport(input); return { acceptedCount: countQuestions(input.questions) } }

  async importQuestions(input: ImportQuestionsInput) {
    await simulateRequest('write')
    const state = getMockAdminState()
    const body = JSON.stringify(importBody(input)), cached = this.imports.get(input.idempotencyKey)
    if (cached) { if (cached.body !== body) throw new ApiError('幂等键已被其他内容使用。', 'IDEMPOTENCY_CONFLICT', 409); return cached.count }
    this.validateImport(input)
    const now = new Date().toISOString()
    // Validate the whole batch before writing so a bad question cannot leave a partial import.
    const questions = input.questions.map((q, index) => {
      const inputQuestion = { ...q, questionBankId: input.questionBankId }
      try {
        this.validateQuestionPlacement(inputQuestion)
        return {
          ...validateQuestion(inputQuestion),
          version: 1,
          revision: 1,
          id: createId('question'),
          createdAt: now,
          updatedAt: now,
        }
      } catch (error) {
        throw new ApiError(`第 ${index + 1} 题：${error instanceof Error ? error.message : '内容无效'}`)
      }
    })
    state.setQuestions([...questions, ...state.questions])
    bumpBank(input.questionBankId)
    this.imports.set(input.idempotencyKey, { body, count: countQuestions(questions) })
    recordOperation('题库工作台', `导入题目（共 ${countQuestions(questions)} 道，${questions.length} 条记录）`)
    return countQuestions(questions)
  }

  async getDashboardSummary() {
    await simulateRequest(); platformOnly()
    const { colleges, subjects, questionBanks, questions, users, activityRecords } = getMockAdminState()
    return {
      collegeCount: colleges.length,
      subjectCount: subjects.length,
      questionBankCount: questionBanks.length,
      questionCount: countQuestions(questions),
      userCount: users.length,
      answeredCount: activityRecords.reduce((sum, r) => sum + r.answeredCount, 0),
      publishedBankCount: questionBanks.filter(b => b.publicationStatus === 'PUBLISHED').length,
      draftBankCount: questionBanks.filter(b => b.publicationStatus === 'DRAFT').length,
      pendingFeedbackCount: getMockAdminState().feedback.filter(f => f.kind === 'QUESTION' && ['OPEN','IN_PROGRESS'].includes(f.status)).length,
      pendingCourseRequestCount: getMockAdminState().feedback.filter(f => f.kind === 'COURSE_REQUEST' && ['OPEN','IN_PROGRESS'].includes(f.status)).length,
      missingExplanationCount: missingExplanations(questions.filter(q => q.status === 'ACTIVE')),
      unassignedQuestionCount: countQuestions(questions.filter(q => !q.chapterId)),
      emptyBankCount: questionBanks.filter(b => !questions.some(q => q.questionBankId === b.id && q.status === 'ACTIVE')).length,
    }
  }

  async listColleges(query?: CollegeQuery) {
    await simulateRequest()
    const keyword = normalize(query?.keyword)
    return paged(getMockAdminState().colleges.filter((college) =>
      normalize(`${college.name} ${college.code}`).includes(keyword) && (!query?.status || college.status === query.status),
    ).map(c => ({ ...c, studentCount: getMockAdminState().users.filter(u => u.collegeId === c.id).length })), query)
  }

  async getCollege(id: string) {
    await simulateRequest()
    const value = getMockAdminState().colleges.find(row => row.id === id)
    if (!value) throw new ApiError('学院不存在', 'NOT_FOUND', 404)
    return structuredClone(value)
  }
  async getMajor(id: string) {
    await simulateRequest()
    const value = getMockAdminState().majors.find(row => row.id === id)
    if (!value) throw new ApiError('专业不存在', 'NOT_FOUND', 404)
    return structuredClone(value)
  }
  async getAdminAccount(id: string) {
    await simulateRequest(); platformOnly()
    const value = getMockAdminState().adminAccounts.find(row => row.id === id)
    if (!value) throw new ApiError('管理员不存在', 'NOT_FOUND', 404)
    return publicAccount(value)
  }

  async createCollege(input: CreateCollegeInput) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    const name = input.name.trim()
    const code = input.code.trim().toUpperCase()
    if (!name || !code) throw new ApiError('名称和代码不能为空。')
    if (state.colleges.some((college) => normalize(college.name) === normalize(name))) {
      throw new ApiError('学院名称已存在。')
    }
    if (state.colleges.some((college) => normalize(college.code) === normalize(code))) {
      throw new ApiError('学院代码已存在。')
    }
    const now = new Date().toISOString()
    const college = { ...input, name, code, id: createId('college'), version: 1, createdAt: now, updatedAt: now }
    state.setColleges([college, ...state.colleges])
    recordOperation('学院管理', `保存：${college.name}`)
    return college
  }

  async updateCollege(id: string, input: UpdateCollegeInput) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    const current = state.colleges.find((college) => college.id === id)
    if (!current) throw new ApiError('学院不存在。', 'NOT_FOUND', 404)
    version(current, input.expectedVersion)
    const name = input.name.trim()
    const code = input.code.trim().toUpperCase()
    if (!name || !code) throw new ApiError('名称和代码不能为空。')
    if (state.colleges.some((college) => college.id !== id && normalize(college.name) === normalize(name))) {
      throw new ApiError('学院名称已存在。')
    }
    if (state.colleges.some((college) => college.id !== id && normalize(college.code) === normalize(code))) {
      throw new ApiError('学院代码已存在。')
    }
    const college = { ...current, ...input, version: current.version + 1, name, code, updatedAt: new Date().toISOString() }
    state.setColleges(state.colleges.map((item) => (item.id === id ? college : item)))
    recordOperation('学院管理', `保存：${college.name}`)
    return college
  }

  async listMajors(query?: MajorQuery) {
    await simulateRequest()
    return paged(getMockAdminState().majors.filter(m => (!query?.collegeId || m.collegeId === query.collegeId) && (!query?.status || m.status === query.status) && normalize(m.name + ' ' + m.code).includes(normalize(query?.keyword))).map(m => ({ ...m, studentCount: getMockAdminState().users.filter(u => u.majorId === m.id).length })), query)
  }

  async createMajor(input: CreateMajorInput) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    if (!state.colleges.some((college) => college.id === input.collegeId)) {
      throw new ApiError('所属学院不存在。', 'NOT_FOUND', 404)
    }
    const name = input.name.trim()
    const code = input.code.trim().toUpperCase()
    if (!name || !code) throw new ApiError('名称和代码不能为空。')
    if (
      state.majors.some(
        (major) => major.collegeId === input.collegeId && normalize(major.name) === normalize(name),
      )
    ) {
      throw new ApiError('该学院下已存在同名专业。')
    }
    if (
      state.majors.some(
        (major) => major.collegeId === input.collegeId && normalize(major.code) === normalize(code),
      )
    ) {
      throw new ApiError('该学院下已存在相同专业代码。')
    }
    const now = new Date().toISOString()
    const major = { ...input, name, code, id: createId('major'), version: 1, createdAt: now, updatedAt: now }
    state.setMajors([major, ...state.majors])
    recordOperation('专业管理', `保存：${major.name}`)
    return major
  }

  async updateMajor(id: string, input: UpdateMajorInput) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    const current = state.majors.find((major) => major.id === id)
    if (!current) throw new ApiError('专业不存在。', 'NOT_FOUND', 404)
    version(current, input.expectedVersion)
    if (
      current.collegeId !== input.collegeId &&
      state.questionBanks.some((b) =>
        b.audiences.some((a) => a.majorId === id && a.collegeId && a.collegeId !== input.collegeId),
      )
    )
      throw new ApiError('迁移会使题库的学院与专业条件冲突，请先调整适用范围。')
    if (current.collegeId !== input.collegeId && state.users.some((u) => u.majorId === id))
      throw new ApiError('专业仍有用户，暂不能迁移学院。')
    if (!state.colleges.some((college) => college.id === input.collegeId)) {
      throw new ApiError('所属学院不存在。', 'NOT_FOUND', 404)
    }
    const name = input.name.trim()
    const code = input.code.trim().toUpperCase()
    if (!name || !code) throw new ApiError('名称和代码不能为空。')
    if (
      state.majors.some(
        (major) =>
          major.id !== id && major.collegeId === input.collegeId && normalize(major.name) === normalize(name),
      )
    ) {
      throw new ApiError('该学院下已存在同名专业。')
    }
    if (
      state.majors.some(
        (major) =>
          major.id !== id && major.collegeId === input.collegeId && normalize(major.code) === normalize(code),
      )
    ) {
      throw new ApiError('该学院下已存在相同专业代码。')
    }
    const major = { ...current, ...input, version: current.version + 1, name, code, updatedAt: new Date().toISOString() }
    state.setMajors(state.majors.map((item) => (item.id === id ? major : item)))
    recordOperation('专业管理', `保存：${major.name}`)
    return major
  }

  async listSubjects(query?: SubjectQuery) {
    await simulateRequest()
    return paged(getMockAdminState().subjects.filter(s => normalize(s.name).includes(normalize(query?.keyword))), query)
  }

  async createSubject(input: CreateSubjectInput) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    if (!input.name.trim() || input.name.length > 50) throw new ApiError('课程名称必填，且最多 50 字。')
    if (state.subjects.some((subject) => normalize(subject.name) === normalize(input.name))) {
      throw new ApiError('课程名称已存在，请使用已有课程。')
    }
    const now = new Date().toISOString()
    const subject = {
      ...input,
      name: input.name.trim(),
      id: createId('subject'),
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    state.setSubjects([subject, ...state.subjects])
    recordOperation('课程管理', `保存：${subject.name}`)
    return subject
  }

  async updateSubject(id: string, input: UpdateSubjectInput) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    const current = state.subjects.find((subject) => subject.id === id)
    if (!current) throw new ApiError('课程不存在。', 'NOT_FOUND', 404)
    version(current, input.expectedVersion)
    if (!input.name.trim() || input.name.length > 50) throw new ApiError('课程名称必填，且最多 50 字。')
    if (
      state.subjects.some((subject) => subject.id !== id && normalize(subject.name) === normalize(input.name))
    ) {
      throw new ApiError('课程名称已存在。')
    }
    const subject = {
      ...current,
      version: current.version + 1,
      ...input,
      name: input.name.trim(),
      updatedAt: new Date().toISOString(),
    }
    state.setSubjects(state.subjects.map((item) => (item.id === id ? subject : item)))
    recordOperation('课程管理', `保存：${subject.name}`)
    return subject
  }

  async listQuestionBanks(query?: QuestionBankQuery) {
    await simulateRequest()
    const actor = getAdminSession()
    return paged(getMockAdminState().questionBanks.filter(b => (!query?.subjectId || b.subjectId === query.subjectId) && (!query?.publicationStatus || b.publicationStatus === query.publicationStatus) && normalize(b.name).includes(normalize(query?.keyword)) && (actor?.role !== 'CONTENT_ADMIN' || b.maintainerIds.includes(actor.id))).map(b => this.bankFacts(b)), query)
  }

  async createQuestionBank(input: CreateQuestionBankInput) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    if (!state.subjects.some((s) => s.id === input.subjectId) || !input.name.trim())
      throw new ApiError('请选择有效课程并填写题库名称。')
    if (state.questionBanks.some((b) => b.subjectId === input.subjectId && normalize(b.name) === normalize(input.name)))
      throw new ApiError('该课程下已有同名题库，请使用不同名称区分教材或年份。')
    const now = new Date().toISOString()
    const bank = {
      ...input,
      ...this.validateBank(input),
      publicationStatus: 'DRAFT' as const,
      status: input.status,
      version: 1,
      contentVersion: 1,
      id: createId('bank'),
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    state.setQuestionBanks([bank, ...state.questionBanks])
    recordOperation('题库工作台', `保存：${bank.name}`)
    return bank
  }

  async updateQuestionBank(id: string, input: UpdateQuestionBankInput) {
    await simulateRequest('write')
    const state = getMockAdminState()
    const current = this.bank(id)
    if (!current) throw new ApiError('题库不存在。', 'NOT_FOUND', 404)
    version(current, input.expectedVersion)
    if (getAdminSession()?.role !== 'PLATFORM_ADMIN' && input.maintainerIds && [...input.maintainerIds].sort().join() !== [...current.maintainerIds].sort().join()) throw new ApiError('只有平台管理员可以修改维护者。', 'FORBIDDEN', 403)
    if (input.subjectId !== current.subjectId) throw new ApiError('题库所属课程不可变更。')
    if (current.publicationStatus === 'PUBLISHED' && !input.description?.trim())
      throw new ApiError('已发布题库的内容说明不能为空。')
    if (!state.subjects.some((s) => s.id === input.subjectId) || !input.name.trim())
      throw new ApiError('请选择有效课程并填写题库名称。')
    if (state.questionBanks.some((b) => b.id !== id && b.subjectId === input.subjectId && normalize(b.name) === normalize(input.name)))
      throw new ApiError('该课程下已有同名题库。')
    if (
      input.subjectId !== current.subjectId &&
      (state.questions.some((q) => q.questionBankId === id) ||
        state.userCourses.some((c) => c.preferredBankId === id))
    )
      throw new ApiError('已有内容或学生选择的题库不能更换所属课程。')
    const bank = {
      ...current,
      version: current.version + 1,
      ...input,
      ...this.validateBank({ ...current, ...input }, current.publicationStatus === 'PUBLISHED'),
      status: input.status,
      contentVersion: current.contentVersion + 1,
      publicationStatus: current.publicationStatus,
      updatedAt: new Date().toISOString(),
    }
    state.setQuestionBanks(state.questionBanks.map((item) => (item.id === id ? bank : item)))
    recordOperation('题库工作台', `保存：${bank.name}`)
    return bank
  }

  async listQuestions(query: QuestionQuery & { questionBankId: string }) {
    await simulateRequest()
    this.bank(query.questionBankId)
    return paged(getMockAdminState().questions.filter(q => q.questionBankId === query.questionBankId && (!query.chapterId || q.chapterId === query.chapterId) && (!query.unassigned || !q.chapterId) && (!query.type || q.type === query.type || q.subQuestions?.some(s => s.type === query.type)) && (!query.status || q.status === query.status) && normalize(questionSearchText(q)).includes(normalize(query.keyword))), query)
  }

  async getQuestion(id: string) {
    await simulateRequest()
    const question = getMockAdminState().questions.find((item) => item.id === id)
    if (!question) throw new ApiError('题目不存在。', 'NOT_FOUND', 404)
    this.bank(question.questionBankId)
    return structuredClone(question)
  }

  async createQuestion(input: CreateQuestionInput) {
    await simulateRequest('write')
    const state = getMockAdminState()
    const now = new Date().toISOString()
    if (!state.questionBanks.some((b) => b.id === input.questionBankId)) throw new ApiError('所属题库不存在。', 'NOT_FOUND', 404)
    this.validateQuestionPlacement(input)
    const question = {
      ...validateQuestion(input),
      version: 1,
      revision: 1,
      id: createId('question'),
      createdAt: now,
      updatedAt: now,
    }
    state.setQuestions([question, ...state.questions])
    bumpBank(input.questionBankId)
    recordOperation('题目管理', `保存：${question.stem}`)
    return question
  }

  async updateQuestion(id: string, input: UpdateQuestionInput) {
    await simulateRequest('write')
    const state = getMockAdminState()
    const current = state.questions.find((question) => question.id === id)
    if (!current) throw new ApiError('题目不存在。', 'NOT_FOUND', 404)
    version(current, input.expectedVersion)
    if (current.type !== input.type) throw new ApiError('已有题目不能切换题型，请新建对应题型。')
    if (current.subQuestions?.some((sub) => input.subQuestions?.some((next) => next.id === sub.id && next.type !== sub.type)))
      throw new ApiError('已有阅读小题不能切换题型，请添加新的小题。')
    if (current.status === 'ACTIVE' && (input.status !== 'ACTIVE' || input.questionBankId !== current.questionBankId))
      this.requireRemainingQuestion(current)
    if (!state.questionBanks.some((b) => b.id === input.questionBankId)) throw new ApiError('所属题库不存在。', 'NOT_FOUND', 404)
    this.validateQuestionPlacement(input)
    const valid = validateQuestion(input)
    const changed = contentFingerprint(current) !== contentFingerprint(valid)
    const question = {
      ...current,
      version: current.version + 1,
      ...valid,
      revision: (current.revision ?? 1) + Number(changed),
      updatedAt: new Date().toISOString(),
    }
    state.setQuestions(state.questions.map((item) => (item.id === id ? question : item)))
    bumpBank(input.questionBankId)
    recordOperation('题目管理', `保存：${question.stem}`)
    return question
  }

  async deactivateQuestion(id: string, expectedVersion: number) {
    const current = await this.getQuestion(id)
    await this.updateQuestion(id, { ...current, status: 'INACTIVE', expectedVersion })
  }

  async getUser(id: string) {
    await simulateRequest(); platformOnly()
    const state = getMockAdminState(), user = state.users.find(u => u.id === id)
    if (!user) throw new ApiError('用户不存在。', 'NOT_FOUND', 404)
    return structuredClone({ ...user, collegeName: state.colleges.find(c => c.id === user.collegeId)?.name, majorName: state.majors.find(m => m.id === user.majorId)?.name })
  }
  async getUserStatistics(id: string) {
    await this.getUser(id)
    const records = getMockAdminState().activityRecords.flatMap(r => r.learning.filter(l => l.userId === id))
    return records.reduce((a,l) => ({ answeredCount: a.answeredCount + l.answeredCount, correctCount: a.correctCount + l.correctCount, durationSeconds: a.durationSeconds + l.durationSeconds }), { answeredCount: 0, correctCount: 0, durationSeconds: 0 })
  }
  async getDirectorySummary(query?: { collegeId?: string; majorId?: string }) {
    await simulateRequest(); platformOnly()
    const state = getMockAdminState(), users = state.users.filter(u => (!query?.collegeId || u.collegeId === query.collegeId) && (!query?.majorId || u.majorId === query.majorId))
    return { collegeCount: state.colleges.length, majorCount: state.majors.filter(m => !query?.collegeId || m.collegeId === query.collegeId).length, studentCount: users.length, grades: [1,2,3,4,5].map(grade => ({ grade, studentCount: users.filter(u => u.grade === grade).length })) }
  }
  async listSubjectAccess(id: string, query?: PageQuery) {
    await simulateRequest(); platformOnly()
    const state = getMockAdminState()
    return paged(state.userCourses.filter(c => c.subjectId === id).map(c => { const u = state.users.find(u => u.id === c.userId)!; return { userId: u.id, nickname: u.name, accountCode: u.account, createdAt: c.addedAt } }), query)
  }
  async grantSubjectAccess(id: string, userId: string, expectedVersion: number) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState(), subject = state.subjects.find(s => s.id === id)
    version(subject, expectedVersion)
    if (!state.users.some(u => u.id === userId && u.status === 'ACTIVE')) throw new ApiError('请选择启用的学生账号。')
    if (!state.userCourses.some(c => c.subjectId === id && c.userId === userId)) {
      state.setOperations({ userCourses: [...state.userCourses, { subjectId: id, userId, addedAt: new Date().toISOString() }] })
      state.setSubjects(state.subjects.map(s => s.id === id ? { ...s, version: s.version + 1 } : s))
    }
  }
  async revokeSubjectAccess(id: string, userId: string, expectedVersion: number) {
    await simulateRequest('write'); platformOnly()
    const state = getMockAdminState()
    version(state.subjects.find(s => s.id === id), expectedVersion)
    state.setOperations({ userCourses: state.userCourses.filter(c => c.subjectId !== id || c.userId !== userId) })
    state.setSubjects(state.subjects.map(s => s.id === id ? { ...s, version: s.version + 1 } : s))
  }
  async uploadImage(bankId: string, file: File) {
    await simulateRequest('write'); this.bank(bankId)
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new ApiError('请选择 5 MiB 以内的 PNG、JPEG 或 WebP 图片。')
    const id = crypto.randomUUID()
    this.images.set(id, file)
    return { id }
  }
  async imageUrl(id: string) { const file = this.images.get(id); if (!file) throw new ApiError('演示图片已失效，请重新上传。'); return URL.createObjectURL(file) }

  private requireRemainingQuestion(question: import('../../src/types/admin').Question) {
    const state = getMockAdminState()
    if (state.questionBanks.some((b) => b.id === question.questionBankId && b.publicationStatus === 'PUBLISHED') &&
      !state.questions.some((q) => q.questionBankId === question.questionBankId && q.id !== question.id && q.status === 'ACTIVE'))
      throw new ApiError('已发布题库至少保留一道启用题目，请先下架再调整。')
  }
}
