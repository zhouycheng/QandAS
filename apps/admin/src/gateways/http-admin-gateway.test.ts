import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpAdminContentGateway } from './http-admin-gateway'
import { questionFromWire, questionToWire } from './question-wire'
import { questionImportExamples } from '../lib/question-import-examples'
const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const page = { items: [], total: 0, page: 1, pageSize: 20 }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('HTTP 管理合同', () => {
  it('测试账号创建与查看凭据使用独立请求，停用携带版本', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 'test-account', status: 'ACTIVE', version: 1 }, 201))
      .mockResolvedValueOnce(json({ email: 'QANDATEST001@qanda.mail', password: 'ExampleTest123456' })).mockResolvedValueOnce(json({ id: 'test-account', version: 2 }))
    const api = new HttpAdminContentGateway('', fetcher, () => 'admin')
    await api.createTestAccount({ validDays: 7, includeInStatistics: false })
    await api.getTestAccountCredentials('test-account')
    await api.disableTestAccount('test-account', 1)
    expect(fetcher.mock.calls.map(row => row[0])).toEqual(['/api/v1/admin/test-accounts', '/api/v1/admin/test-accounts/test-account/credentials', '/api/v1/admin/test-accounts/test-account/status'])
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({ validDays: 7, includeInStatistics: false })
    expect(fetcher.mock.calls[1][1]?.method).toBe('GET')
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty('Idempotency-Key')
    expect(JSON.parse(fetcher.mock.calls[2][1]?.body as string)).toEqual({ expectedVersion: 1 })
  })

  it('默认请求保持浏览器 fetch 的全局上下文', async () => {
    vi.stubGlobal('fetch', function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(json(page))
    })
    const api = new HttpAdminContentGateway('', undefined, () => '')
    expect((await api.listColleges()).items).toEqual([])
  })
  it('列表只请求当前页，并传递范围、排序与请求追踪', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(page))
    const api = new HttpAdminContentGateway('https://api.example.test/api/v1/', fetcher, () => 'admin-token')
    await api.getRankings({ period: 'WEEK', sort: 'DURATION', page: 2, pageSize: 20 })
    const [url, options] = fetcher.mock.calls[0]
    const parsed = new URL(String(url))
    expect(parsed.pathname).toBe('/api/v1/admin/statistics/rankings')
    expect(parsed.searchParams.get('page')).toBe('2')
    expect(parsed.searchParams.get('sort')).toBe('DURATION')
    expect(parsed.searchParams.has('grade')).toBe(false)
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer admin-token', 'X-Request-Id': expect.any(String) })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('拒绝不符合分页合同的响应', async () => {
    const api = new HttpAdminContentGateway('', vi.fn<typeof fetch>().mockResolvedValue(json([])), () => '')
    await expect(api.listQuestionBanks()).rejects.toThrow('列表读取失败，请稍后重试')
  })
  it('管理员重新登录不携带过期令牌，身份查询使用新令牌', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ accessToken: 'new', expiresAt: '2027-01-01T00:00:00Z', sessionMinutes: 60 }))
      .mockResolvedValueOnce(json({ id: 'admin', role: 'SUPER_ADMIN' })).mockResolvedValueOnce(json({ id: 'session', version: 1 }))
    const api = new HttpAdminContentGateway('', fetcher, () => 'expired-token')
    expect((await api.loginAdmin('editor', 'password')).sessionMinutes).toBe(60)
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer new' })
    await api.logoutAdmin()
    expect(fetcher.mock.calls.map(row => row[0])).toEqual(['/api/v1/admin/auth/sessions', '/api/v1/admin/auth/me', '/api/v1/admin/auth/logout'])
  })
  it('创建管理员返回规范化账号和默认身份', async () => {
    const api = new HttpAdminContentGateway('', vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'admin', version: 1 })), () => 'token')
    const account = await api.saveAdminAccount(undefined, { name: ' 老师 ', username: ' Admin.Name ', password: 'Password12345' })
    expect(account).toMatchObject({ name: '老师', username: 'admin.name', status: 'ACTIVE', role: 'SUPER_ADMIN' })
  })
  it('响应丢失、服务端失败和限流重试保留原幂等键，账号切换分开', async () => {
    let token = 'a'
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(json({ code: 'SERVER_ERROR' }, 503))
      .mockResolvedValueOnce(json({ code: 'RATE_LIMITED' }, 429, { 'Retry-After': '45' })).mockResolvedValueOnce(json({ id: 'course', version: 2 })).mockResolvedValueOnce(json({ id: 'course', version: 3 }))
    const api = new HttpAdminContentGateway('', fetcher, () => token)
    const send = () => api.disableTestAccount('test-account', 1)
    await expect(send()).rejects.toThrow('response lost')
    await expect(send()).rejects.toMatchObject({ status: 503 })
    await expect(send()).rejects.toMatchObject({ retryAfterSeconds: 45 })
    await send()
    const keys = fetcher.mock.calls.map(row => (row[1]?.headers as Record<string, string>)['Idempotency-Key'])
    expect(new Set(keys).size).toBe(1)
    token = 'b'; await send()
    expect((fetcher.mock.calls[4][1]?.headers as Record<string, string>)['Idempotency-Key']).not.toBe(keys[0])
  })
  it('版本冲突暴露错误码和请求号，撤销传递并发版本', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ code: 'VERSION_CONFLICT', message: '内容已更新' }, 409, { 'X-Request-Id': 'request-test' }))
    const api = new HttpAdminContentGateway('', fetcher, () => 'token')
    await expect(api.disableTestAccount('test-account', 8)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, requestId: 'request-test' })
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/admin/test-accounts/test-account/status')
    expect(fetcher.mock.calls[0][1]?.method).toBe('PUT')
  })
  it('管理员内容写入直接提交，失败重试保留幂等键', async () => {
    let writes = 0
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      writes++
      if (writes === 1) throw new Error('response lost')
      if (writes === 2) return json({ code: 'SERVER_ERROR' }, 503)
      if (writes === 3) return json({ code: 'RATE_LIMITED' }, 429)
      return json({ id: 'college', version: writes })
    })
    const api = new HttpAdminContentGateway('', fetcher, () => 'admin')
    const send = () => api.createCollege({ code: 'C', name: '学院', status: 'ACTIVE' })
    await expect(send()).rejects.toThrow('response lost')
    await expect(send()).rejects.toMatchObject({ status: 503 })
    await expect(send()).rejects.toMatchObject({ status: 429 })
    await send()
    const attempts = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/admin/colleges'))
    expect(new Set(attempts.map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key'])).size).toBe(1)
    expect(fetcher.mock.calls).toHaveLength(4)
    expect(attempts).toHaveLength(4)
    expect(attempts.every(([, init]) => !Object.hasOwn(init?.headers ?? {}, 'X-Content-Safety-Request'))).toBe(true)
    await send()
    expect(fetcher.mock.calls).toHaveLength(5)
  })
  it('账号切换拒收旧响应，旧请求认证失败不清除新账号', async () => {
    let token = 'old', finish!: (response: Response) => void
    const api = new HttpAdminContentGateway('', vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve })), () => token)
    const pending = api.listUsers()
    token = 'new'; finish(json({ code: 'UNAUTHORIZED' }, 401))
    await expect(pending).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' })
  })
  it('超时终止请求，重试仍复用写入键', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))))
      .mockResolvedValueOnce(json({ id: 'course', version: 2 }))
    const api = new HttpAdminContentGateway('', fetcher, () => 'token')
    const pending = expect(api.disableTestAccount('test-account', 1)).rejects.toThrow('请求超时')
    await vi.advanceTimersByTimeAsync(30000); await pending
    await api.disableTestAccount('test-account', 1)
    expect((fetcher.mock.calls[0][1]?.headers as Record<string,string>)['Idempotency-Key']).toBe((fetcher.mock.calls[1][1]?.headers as Record<string,string>)['Idempotency-Key'])
  })
  it('响应正文尚未读完时切换账号，丢弃数据且不清除新会话', async () => {
    const removeItem = vi.fn()
    vi.stubGlobal('window', { localStorage: { removeItem }, dispatchEvent: vi.fn() })
    for (const status of [200, 401]) {
      let token = 'old', finish!: (body: unknown) => void, started!: () => void
      const reading = new Promise<void>(resolve => { started = resolve })
      const response = json(page, status)
      vi.spyOn(response, 'json').mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve }) })
      const api = new HttpAdminContentGateway('', vi.fn<typeof fetch>().mockResolvedValue(response), () => token)
      const pending = api.listUsers()
      await reading
      token = 'new'; finish(status === 200 ? page : { code: 'UNAUTHORIZED' })
      await expect(pending).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' })
    }
    expect(removeItem).not.toHaveBeenCalled()
  })
  it('六类题型与阅读小题使用同一传输，判断答案为布尔值', () => {
    for (const example of Object.values(questionImportExamples)) {
      const wire = questionToWire(example)
      if (example.type === 'TRUE_FALSE') { expect(wire.correctValue).toBe(true); expect(wire.correctAnswer).toEqual([]) }
      if (example.type === 'READING') expect((wire.subQuestions as { id: string }[]).every(row => /^[0-9a-f-]{36}$/.test(row.id))).toBe(true)
      const restored = questionFromWire(wire as unknown as typeof example)
      expect(restored.type).toBe(example.type)
      expect(restored.correctAnswer).toEqual(example.correctAnswer)
    }
  })
  it('导入预览失败保持具体问题，正文限制按 UTF-8 字节计算', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ valid: false, questionCount: 1, issues: [{ message: '解析缺失' }] }))
    const api = new HttpAdminContentGateway('', fetcher, () => 'token')
    const input = { questionBankId: 'bank', expectedContentVersion: 3, idempotencyKey: 'intent', questions: [{ ...questionImportExamples.SINGLE_CHOICE, questionBankId: 'bank', status: 'ACTIVE' as const }] }
    await expect(api.previewImport(input)).rejects.toThrow('解析缺失')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).expectedContentVersion).toBe(3)
    await expect(api.previewImport({ ...input, questions: [{ ...input.questions[0], stem: '题'.repeat(3 * 1024 * 1024) }] })).rejects.toThrow('8 MiB')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('图片通过带认证的二进制请求读取，附件上传带幂等键', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 'image' })).mockResolvedValueOnce(new Response(new Blob(['png'], { type: 'image/png' })))
    const api = new HttpAdminContentGateway('', fetcher, () => 'token')
    await api.uploadImage('bank', new File(['png'], 'image.png', { type: 'image/png' }))
    const url = await api.imageUrl('image')
    expect(url.startsWith('blob:')).toBe(true); URL.revokeObjectURL(url)
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ 'Content-Type': 'image/png', 'Idempotency-Key': expect.any(String) })
    expect(fetcher.mock.calls[1][0]).toBe('/api/v1/files/image')
  })
})
