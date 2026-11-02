import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateQuestionInput, QuestionBank } from '../../src/types/admin'
import { parseQuestionFile } from '../../src/lib/content-rules'
import { getAdminSession, isAuthenticated, saveAdminSession } from '../../src/lib/auth'
import { recommendedBanks } from '../../src/lib/recommendations'
import { questionImportExamples } from '../../src/lib/question-import-examples'

let gateway: import('./mock-admin-gateway').MockAdminContentGateway
let store: typeof import('../store/mock-admin-store').useMockAdminStore
const memory = new Map<string, string>()
const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) }, removeItem: (key: string) => { memory.delete(key) } }
const question: CreateQuestionInput = { questionBankId: 'bank-calculus', type: 'SINGLE_CHOICE', stem: '1 + 1 = ?', options: [{ key: 'A', content: '2' }, { key: 'B', content: '3' }], correctAnswer: ['A'], explanation: '1 + 1 = 2', status: 'ACTIVE' }
const bank = (id = 'bank-calculus') => store.getState().questionBanks.find(b => b.id === id)!
const example = (type: keyof typeof questionImportExamples): CreateQuestionInput => ({ ...structuredClone(questionImportExamples[type]), questionBankId: 'bank-calculus', status: 'ACTIVE' })
const importInput = (questions: CreateQuestionInput[]) => ({ questionBankId: 'bank-calculus', questions, expectedContentVersion: bank().contentVersion, idempotencyKey: crypto.randomUUID() })
const publish = (id: string, status: QuestionBank['publicationStatus']) => gateway.setBankPublication(id, status, bank(id).version)
async function run<T>(operation: () => Promise<T>): Promise<T> {
  const result = operation().then(value => ({ value }), error => ({ error }))
  await vi.runAllTimersAsync()
  const settled = await result
  if ('error' in settled) throw settled.error
  return settled.value
}
const session = (index = 0) => {
  const account = store.getState().adminAccounts[index], accessToken = 'mock-session-' + index, expiresAt = new Date(Date.now() + 86400000).toISOString()
  storage.setItem('qanda-mock-session:' + accessToken, JSON.stringify({ id: account.id, credentialVersion: account.credentialVersion ?? 1, expiresAt }))
  saveAdminSession({ account, accessToken, expiresAt, sessionMinutes: 30 })
}
beforeAll(async () => {
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', { localStorage: storage, setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args) })
  store = (await import('../store/mock-admin-store')).useMockAdminStore
})
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T12:00:00+08:00'))
  memory.clear()
  store.getState().setScenario('normal')
  gateway = new (await import('./mock-admin-gateway')).MockAdminContentGateway()
  session()
})
afterEach(() => vi.useRealTimers())

describe('分页、资料范围和历史保护', () => {
  it('列表只返回当前页，保持总量与稳定顺序', async () => {
    store.getState().setScenario('large-data')
    const first = await run(() => gateway.listQuestions({ questionBankId: 'bank-calculus', pageSize: 5 }))
    const next = await run(() => gateway.listQuestions({ questionBankId: 'bank-calculus', page: 2, pageSize: 5 }))
    expect(first.items).toHaveLength(5)
    expect(first.total).toBeGreaterThan(100)
    expect(next.total).toBe(first.total)
    expect(next.items.some(q => first.items.some(p => p.id === q.id))).toBe(false)
    await expect(run(() => gateway.listUsers({ page: 0 }))).rejects.toThrow('分页')
  })
  it('固定五档年级提供汇总，停用分类保留学生资料', async () => {
    const before = structuredClone(store.getState().users)
    const summary = await run(() => gateway.getDirectorySummary({ collegeId: 'college-computer-science' }))
    expect(summary.grades.map(g => g.grade)).toEqual([1,2,3,4,5])
    expect(summary.studentCount).toBe(before.filter(u => u.collegeId === 'college-computer-science').length)
    const college = store.getState().colleges[0], major = store.getState().majors[0]
    await run(() => gateway.updateCollege(college.id, { ...college, expectedVersion: college.version, status: 'INACTIVE' }))
    await run(() => gateway.updateMajor(major.id, { ...major, expectedVersion: major.version, status: 'INACTIVE' }))
    expect(store.getState().users).toEqual(before)
    expect((await run(() => gateway.listUsers({ grade: 2 }))).items.every(u => u.grade === 2)).toBe(true)
  })
  it('资料自由切换与课程单独开放均改变可见范围', async () => {
    const state = store.getState(), user = state.users.find(u => u.majorId === 'major-english')!
    const banks = (await run(() => gateway.listQuestionBanks())).items
    expect(recommendedBanks(user, banks, state.subjects).map(b => b.id)).toEqual(['bank-english-grammar'])
    expect(recommendedBanks({ ...user, majorId: 'major-computer-science' }, banks, state.subjects).some(b => b.id === 'bank-calculus')).toBe(true)
    expect(recommendedBanks(user, banks, state.subjects, ['subject-math']).some(b => b.id === 'bank-calculus')).toBe(true)
    const subject = state.subjects[0]
    await run(() => gateway.grantSubjectAccess(subject.id, 'user-5', subject.version))
    expect((await run(() => gateway.listSubjectAccess(subject.id))).items.some(u => u.userId === 'user-5')).toBe(true)
    await expect(run(() => gateway.revokeSubjectAccess(subject.id, 'user-5', subject.version))).rejects.toThrow('已更新')
    await run(() => gateway.revokeSubjectAccess(subject.id, 'user-5', subject.version + 1))
  })
  it('版本冲突和跨学院专业均阻止范围写入', async () => {
    const original = structuredClone(bank())
    await expect(run(() => gateway.updateQuestionBank(original.id, { ...original, expectedVersion: 0 }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, requestId: expect.any(String) })
    await expect(run(() => gateway.updateQuestionBank(original.id, { ...original, expectedVersion: original.version, audiences: [{ collegeId: 'college-foreign-languages', majorId: 'major-computer-science' }] }))).rejects.toThrow('不属于')
    await expect(run(() => gateway.updateQuestionBank(original.id, { ...original, expectedVersion: original.version, audiences: [{ grade: 6 }] }))).rejects.toThrow('年级')
    expect(bank()).toEqual(original)
  })
  it('课程支持多题库，同课程名称去重，草稿可暂缺范围', async () => {
    const input = { subjectId: 'subject-math', name: '新题库', description: '', status: 'ACTIVE' as const, scopeType: 'TARGETED' as const, audiences: [] }
    const created = await run(() => gateway.createQuestionBank(input))
    expect(created.publicationStatus).toBe('DRAFT')
    await expect(run(() => gateway.createQuestionBank(input))).rejects.toThrow('同名题库')
    await run(() => gateway.createQuestionBank({ ...input, subjectId: 'subject-english' }))
    expect((await run(() => gateway.listQuestionBanks({ publicationStatus: 'DRAFT' }))).total).toBe(2)
  })
  it('发布检查与启用题目编辑共用内容规则，下架归档保留题目', async () => {
    const original = store.getState().questions[0]
    await expect(run(() => gateway.updateQuestion(original.id, { ...original, expectedVersion: original.version, explanation: '' }))).rejects.toThrow('必须有解析')
    await run(() => publish(bank().id, 'UNPUBLISHED'))
    const updated = await run(() => gateway.updateQuestion(original.id, { ...original, expectedVersion: original.version, explanation: '' }))
    expect((await run(() => gateway.publicationChecks(bank().id))).some(c => !c.passed)).toBe(true)
    await expect(run(() => publish(bank().id, 'PUBLISHED'))).rejects.toThrow('解析')
    await run(() => gateway.updateQuestion(updated.id, { ...updated, expectedVersion: updated.version, explanation: '已补充解析' }))
    await run(() => publish(bank().id, 'PUBLISHED'))
    await run(() => publish(bank().id, 'ARCHIVED'))
    expect(store.getState().questions.find(q => q.id === original.id)).toBeDefined()
  })
  it('最后一道启用题必须先下架；停用保留反馈快照', async () => {
    const only = store.getState().questions.find(q => q.questionBankId === 'bank-english-grammar')!
    await expect(run(() => gateway.deactivateQuestion(only.id, only.version))).rejects.toThrow('先下架')
    const snapshot = structuredClone(store.getState().feedback[0])
    const first = store.getState().questions[0]
    await run(() => gateway.deactivateQuestion(first.id, first.version))
    expect(store.getState().questions.find(q => q.id === first.id)?.status).toBe('INACTIVE')
    expect(store.getState().feedback[0]).toEqual(snapshot)
  })
  it('仅空章节可删除，章节顺序需匹配内容版本且归属有效', async () => {
    const existing = store.getState().chapters[0]
    await expect(run(() => gateway.deleteChapter(existing))).rejects.toThrow('仍有题目')
    await expect(run(() => gateway.createQuestion({ ...question, chapterId: 'chapter-tense' }))).rejects.toThrow('不属于')
    const chapter = await run(() => gateway.saveChapter(undefined, { questionBankId: bank().id, name: '新章节', sortOrder: 2 }))
    const ids = [chapter.id, 'chapter-derivatives', 'chapter-limits']
    await run(() => gateway.reorderChapters(bank().id, ids, bank().contentVersion))
    expect((await run(() => gateway.listChapters(bank().id)))[0].id).toBe(chapter.id)
    await expect(run(() => gateway.reorderChapters(bank().id, [chapter.id, chapter.id], bank().contentVersion))).rejects.toThrow('顺序')
    const current = store.getState().chapters.find(c => c.id === chapter.id)!
    await run(() => gateway.deleteChapter(current))
  })
})

describe('六类内容、整批导入与原键重试', () => {
  it('六类内容导入及阅读小题计数', async () => {
    const rows = parseQuestionFile(JSON.stringify({ questions: Object.values(questionImportExamples) }), bank().id)
    const input = importInput(rows), before = store.getState().questions.length
    expect((await run(() => gateway.previewImport(input))).acceptedCount).toBe(7)
    expect(await run(() => gateway.importQuestions(input))).toBe(7)
    expect(await run(() => gateway.importQuestions(input))).toBe(7)
    expect(store.getState().questions).toHaveLength(before + 6)
    await expect(run(() => gateway.importQuestions({ ...input, questions: [question] }))).rejects.toThrow('幂等键')
  })
  it('坏题与跨题库章节使整批回滚', async () => {
    const before = structuredClone(store.getState().questions), version = bank().contentVersion
    for (const bad of [{ ...question, stem: '' }, { ...question, chapterId: 'chapter-tense' }]) await expect(run(() => gateway.importQuestions(importInput([question, bad])))).rejects.toThrow('第 2 题')
    expect(store.getState().questions).toEqual(before)
    expect(bank().contentVersion).toBe(version)
  })
  it('3000 道允许，3001 道与 8 MiB 超限被拒绝', async () => {
    const valid = importInput(Array.from({ length: 3000 }, () => question))
    expect((await run(() => gateway.previewImport(valid))).acceptedCount).toBe(3000)
    await expect(run(() => gateway.previewImport({ ...valid, questions: [...valid.questions, question] }))).rejects.toThrow('3000')
    const large = { ...question, explanation: '文'.repeat(2000) }
    await expect(run(() => gateway.previewImport(importInput(Array.from({ length: 3000 }, () => large))))).rejects.toThrow('8 MiB')
  })
  it('阅读材料修改和小题顺序递增修订；移除小题保留原反馈快照', async () => {
    const created = await run(() => gateway.createQuestion(example('READING')))
    const snapshot = structuredClone(created)
    store.setState({ feedback: [{ ...store.getState().feedback[0], questionId: created.subQuestions![0].id, questionSnapshot: snapshot }] })
    const updated = await run(() => gateway.updateQuestion(created.id, { ...created, expectedVersion: created.version, passage: '更新材料', subQuestions: created.subQuestions!.slice(1) }))
    expect(updated.revision).toBe(2)
    expect(store.getState().feedback[0].questionSnapshot).toEqual(snapshot)
    expect((await run(() => gateway.listQuestions({ questionBankId: bank().id, keyword: '更新材料', type: 'SHORT_ANSWER' }))).items.map(q => q.id)).toContain(created.id)
  })
  it('填空答案与简答评分要点可修订，评分要点允许留空', async () => {
    const fill = await run(() => gateway.createQuestion(example('FILL_BLANK')))
    const updated = await run(() => gateway.updateQuestion(fill.id, { ...fill, expectedVersion: fill.version, blanks: [{ answers: ['water'] }, fill.blanks![1]] }))
    expect(updated.revision).toBe(2)
    const short = await run(() => gateway.createQuestion({ ...example('SHORT_ANSWER'), scoringPoints: [] }))
    expect(short.referenceAnswer).toBeTruthy()
  })
})

describe('管理员会话、运营与场景隔离', () => {
  it('保存的演示数据升级时保留账号和业务内容', async () => {
    const saved = JSON.parse(JSON.stringify(store.getState()))
    saved.adminAccounts[0].role = 'PLATFORM_ADMIN'
    saved.adminAccounts[1].role = 'CONTENT_ADMIN'
    saved.subjects[0].name = '已保存课程'
    storage.setItem('qanda-admin-playground-v1-contract', JSON.stringify({ state: saved, version: 1 }))
    await store.persist.rehydrate()
    expect(store.getState().adminAccounts.every(account => account.role === 'SUPER_ADMIN')).toBe(true)
    expect(store.getState().subjects[0].name).toBe('已保存课程')
  })
  it('失败锁定、登录合同与空闲过期', async () => {
    memory.clear()
    for (let i = 0; i < 5; i++) await expect(run(() => gateway.loginAdmin('admin', 'wrong'))).rejects.toThrow('账号或密码')
    await expect(run(() => gateway.loginAdmin('admin', 'mock'))).rejects.toThrow('锁定')
    vi.advanceTimersByTime(31 * 60000)
    const login = await run(() => gateway.loginAdmin('admin', 'mock'))
    expect(login.account).not.toHaveProperty('passwordHash')
    saveAdminSession({ ...login, sessionMinutes: 5 })
    expect(isAuthenticated()).toBe(true)
    vi.advanceTimersByTime(5 * 60000)
    expect(isAuthenticated()).toBe(false)
    await expect(run(() => gateway.listUsers())).rejects.toThrow('重新登录')
  })
  it('新管理员拥有完整管理权限并保留独立会话和审计', async () => {
    const account = await run(() => gateway.saveAdminAccount(undefined, { name: '老师', username: 'new_admin', status: 'ACTIVE', password: 'Password12345' }))
    expect(account.role).toBe('SUPER_ADMIN')
    await expect(run(() => gateway.saveAdminAccount(undefined, { name: '弱密码', username: 'weak_admin', status: 'ACTIVE', password: '123' }))).rejects.toThrow('密码至少')
    const first = await run(() => gateway.loginAdmin('admin', 'mock'))
    const second = await run(() => gateway.loginAdmin('new_admin', 'Password12345'))
    expect(second.account.id).toBe(account.id)
    expect(second.accessToken).not.toBe(first.accessToken)
    saveAdminSession(second)
    store.setState({ questionBanks: store.getState().questionBanks.map(b => ({ ...b, maintainerIds: [] })) })
    expect((await run(() => gateway.listQuestionBanks())).total).toBeGreaterThan(1)
    await run(() => gateway.createQuestion({ ...question, questionBankId: 'bank-english-grammar' }))
    await run(() => gateway.listUsers())
    await run(() => gateway.getActivity({}))
    await run(() => gateway.listFeedback({ kind: 'COURSE_REQUEST' }))
    const third = await run(() => gateway.saveAdminAccount(undefined, { name: '同事', username: 'third_admin', status: 'ACTIVE', password: 'Password12345' }))
    expect(store.getState().operationLogs.some(log => log.actor === 'new_admin' && log.content.includes(third.username))).toBe(true)
    saveAdminSession(first)
    await run(() => gateway.disableAdminAccount(account.id, account.version))
    saveAdminSession(second)
    await expect(run(() => gateway.listUsers())).rejects.toThrow('重新登录')
    expect(getAdminSession()).toBeNull()
    saveAdminSession(first)
    await run(() => gateway.listUsers())
  })
  it('最后一个有效管理员不能停用', async () => {
    const account = store.getState().adminAccounts[0]
    store.setState({ adminAccounts: [account] })
    await expect(run(() => gateway.disableAdminAccount(account.id, account.version))).rejects.toThrow('至少保留')
  })
  it('管理员账号和密码使用与服务端一致的边界', async () => {
    const account = await run(() => gateway.saveAdminAccount(undefined, { name: '  老师  ', username: '  Long.Name  ', password: 'Password12345' }))
    expect(account).toMatchObject({ name: '老师', username: 'long.name', status: 'ACTIVE', role: 'SUPER_ADMIN' })
    await expect(run(() => gateway.saveAdminAccount(undefined, { name: '老师', username: 'a'.repeat(65), password: 'Password12345' }))).rejects.toThrow('64')
    await expect(run(() => gateway.saveAdminAccount(undefined, { name: '老师', username: 'long_password', password: 'A1' + 'x'.repeat(127) }))).rejects.toThrow('密码至少')
    await expect(run(() => gateway.saveAdminAccount(account.id, { ...account, password: '', expectedVersion: account.version }))).rejects.toThrow('密码至少')
  })
  it('修改密码只使该账号的会话失效', async () => {
    const first = await run(() => gateway.loginAdmin('admin', 'mock'))
    const second = await run(() => gateway.loginAdmin('content_editor', 'mock'))
    saveAdminSession(first)
    await run(() => gateway.saveAdminAccount(second.account.id, { ...second.account, password: 'NewPassword123', expectedVersion: second.account.version }))
    saveAdminSession(second)
    await expect(run(() => gateway.listUsers())).rejects.toThrow('重新登录')
    saveAdminSession(first)
    await run(() => gateway.listUsers())
    expect((await run(() => gateway.loginAdmin('content_editor', 'NewPassword123'))).account.id).toBe(second.account.id)
  })
  it('回复后学生原始反馈保持不变，版本防止重复覆盖', async () => {
    const before = structuredClone(store.getState().feedback[0])
    await expect(run(() => gateway.updateFeedback(before, { status: 'RESOLVED', response: ' ' }))).rejects.toThrow('回复')
    await run(() => gateway.updateFeedback(before, { status: 'RESOLVED', response: '已修正' }))
    expect(store.getState().feedback[0]).toMatchObject({ status: 'RESOLVED', questionSnapshot: before.questionSnapshot, body: before.body, version: before.version + 1 })
    await expect(run(() => gateway.updateFeedback(before, { status: 'OPEN', response: '' }))).rejects.toThrow('已更新')
  })
  it('公告草稿、定时与发布校验', async () => {
    const input = { ...store.getState().announcements[0], title: '新公告', status: 'DRAFT' as const, body: '', summary: '' }
    const draft = await run(() => gateway.saveAnnouncement(undefined, input))
    await expect(run(() => gateway.saveAnnouncement(draft.id, { ...input, expectedVersion: draft.version, status: 'PUBLISHED' }))).rejects.toThrow('摘要')
    await run(() => gateway.saveAnnouncement(draft.id, { ...input, expectedVersion: draft.version, status: 'SCHEDULED', body: '正文', summary: '摘要', publishAt: new Date(Date.now() + 60000).toISOString() }))
    vi.advanceTimersByTime(61000)
    expect((await run(() => gateway.listAnnouncements())).items.find(a => a.id === draft.id)?.status).toBe('PUBLISHED')
  })
  it('置顶入群公告排在更新的普通公告前', async () => {
    const input = { ...store.getState().announcements[0], title: '用户交流群', status: 'PUBLISHED' as const, body: '欢迎交流与反馈', summary: '加入用户交流群', pinned: true, showCommunityGroup: true }
    const pinned = await run(() => gateway.saveAnnouncement(undefined, input))
    vi.advanceTimersByTime(1000)
    await run(() => gateway.saveAnnouncement(undefined, { ...input, title: '普通公告', pinned: false, showCommunityGroup: false }))
    const first = (await run(() => gateway.listAnnouncements({ pageSize: 1 }))).items[0]
    expect(first.id).toBe(pinned.id)
    expect(first.showCommunityGroup).toBe(true)
  })
  it('写入失败和切换场景不污染数据', async () => {
    store.getState().setScenario('write-error')
    const before = structuredClone(store.getState().questions)
    await expect(run(() => gateway.createQuestion(question))).rejects.toThrow('服务异常')
    expect(store.getState().questions).toEqual(before)
    store.getState().setScenario('normal')
    const pending = gateway.createQuestion(question).catch(error => error)
    store.getState().setScenario('empty')
    await vi.runAllTimersAsync()
    expect((await pending).message).toContain('场景已切换')
    expect(store.getState().questions).toEqual([])
  })
  it('三种排行榜支持筛选和稳定分页，卡片时点不随趋势变化', async () => {
    const current = await run(() => gateway.getActivity({ period: 'WEEK' }))
    const past = await run(() => gateway.getActivity({ period: 'MONTH', periodDate: '2020-01-01' }))
    expect(past.dailyActive).toBe(current.dailyActive)
    expect(past.records).toHaveLength(30)
    expect(past.records.every(r => r.activeUsers === 0)).toBe(true)
    for (const sort of ['ACTIVE_DAYS', 'ANSWERED_COUNT', 'DURATION'] as const) {
      const first = await run(() => gateway.getRankings({ sort, pageSize: 2 }))
      const next = await run(() => gateway.getRankings({ sort, pageSize: 2, page: 2 }))
      expect(next.items.some(r => first.items.some(p => p.userId === r.userId))).toBe(false)
      expect(first.items[0].rank).toBe(1)
    }
    expect((await run(() => gateway.getRankings({ grade: 2 }))).items.every(r => r.currentGrade === 2)).toBe(true)
  })
  it('前台会话按用户去重，过期、撤销和客户端筛选分别生效', async () => {
    const user = store.getState().users.find(u => u.status === 'ACTIVE')!
    const seenAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 600000).toISOString()
    store.getState().setOperations({ foregroundSessions: [
      { userId: user.id, platform: 'WEB', seenAt, expiresAt, revoked: false },
      { userId: user.id, platform: 'MINI_PROGRAM', seenAt, expiresAt, revoked: false },
      { userId: 'absent', platform: 'WEB', seenAt, expiresAt, revoked: false }
    ] })
    expect((await run(() => gateway.getActivity({}))).onlineUsers).toBe(1)
    expect((await run(() => gateway.getActivity({ platform: 'WEB' }))).onlineUsers).toBe(1)
    store.getState().setOperations({ foregroundSessions: store.getState().foregroundSessions.map(s => ({ ...s, revoked: true })) })
    expect((await run(() => gateway.getActivity({}))).onlineUsers).toBe(0)
    store.getState().setOperations({ foregroundSessions: [{ userId: user.id, platform: 'WEB', seenAt, expiresAt, revoked: false }] })
    vi.advanceTimersByTime(120001)
    expect((await run(() => gateway.getActivity({}))).onlineUsers).toBe(0)
  })
})
