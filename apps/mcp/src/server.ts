import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { memorySkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills'
import { unzipSync } from 'fflate'
import { z } from 'zod'

const resource = new URL(process.env.QANDA_MCP_RESOURCE || 'http://localhost:8090/mcp')
if (resource.pathname !== '/mcp' || resource.search || resource.hash) throw new Error('QANDA_MCP_RESOURCE must end in /mcp')
const issuer = resource.origin
const backend = new URL(process.env.QANDA_API_UPSTREAM || 'http://localhost:8083')
const skillsZip = await readFile(process.env.QANDA_SKILLS_ZIP || new URL('../../admin/public/qanda-bank-skills.zip', import.meta.url))
const skills = await SkillsExtension.load(memorySkillFiles(unzipSync(skillsZip)), { strict: true })
const scopes = ['banks:read', 'banks:write', 'banks:publish', 'catalog:read', 'catalog:write', 'users:read', 'users:write', 'test_accounts:read', 'test_accounts:write', 'admins:read', 'announcements:read', 'announcements:write', 'feedback:read', 'feedback:write', 'operations:read', 'security:read', 'security:write', 'audit:read']
const service = (path: string, init: RequestInit) => fetch(new URL(path, backend), { ...init, redirect: 'error' })
async function readBody(request: Request, limit: number): Promise<ArrayBuffer | null> {
  if (Number(request.headers.get('Content-Length')) > limit) return null
  const reader = request.body?.getReader()
  if (!reader) return new ArrayBuffer(0)
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) { await reader.cancel(); return null }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes.buffer
}
const uuid = z.uuid(), bank = { bankId: uuid }, page = { page: z.number().int().positive().optional(), keyword: z.string().optional() }
const write = { ...bank, idempotencyKey: uuid }, input = z.record(z.string(), z.unknown())
const question = z.looseObject({
  questionBankId: uuid, type: z.string(),
  stem: z.string().describe('Use an empty string for an untitled READING group. Other types require a non-blank stem.'),
  portableId: uuid.optional(),
  assetIds: z.array(uuid).optional(), options: z.array(z.object({ key: z.string(), content: z.string() })).optional(),
  correctAnswer: z.array(z.string()).optional(), subQuestions: z.array(input).optional(),
}).describe('Flat question fields matching the companion skill. Put stem, options, answers, images and explanation directly in input.')
const systemTools = [
  ['system_list_colleges', 'catalog:read'],
  ['system_list_majors', 'catalog:read'],
  ['system_list_subjects', 'catalog:read'],
  ['system_save_college', 'catalog:write'],
  ['system_save_major', 'catalog:write'],
  ['system_save_subject', 'catalog:write'],
  ['system_list_users', 'users:read'],
  ['system_get_user', 'users:read'],
  ['system_save_user_profile', 'users:write'],
  ['system_set_user_status', 'users:write'],
  ['system_list_test_accounts', 'test_accounts:read'],
  ['system_create_test_account', 'test_accounts:write'],
  ['system_disable_test_account', 'test_accounts:write'],
  ['system_list_admins', 'admins:read'],
  ['system_list_announcements', 'announcements:read'],
  ['system_save_announcement', 'announcements:write'],
  ['system_list_feedback', 'feedback:read'],
  ['system_list_requests', 'feedback:read'],
  ['system_handle_feedback', 'feedback:write'],
  ['system_handle_request', 'feedback:write'],
  ['system_get_dashboard', 'operations:read'],
  ['system_get_security_policy', 'security:read'],
  ['system_save_security_policy', 'security:write'],
  ['system_list_audit', 'audit:read'],
] as const
const systemWrite = { id: uuid.optional(), input, idempotencyKey: uuid }
const systemRead = { ...page, id: uuid.optional(), status: z.string().optional() }
const tools = [
  ...systemTools.map(([name, scope]) => [name, name.replaceAll('_', ' '), scope.endsWith(':read') ? systemRead : systemWrite] as const),
  ['dissolve_chapter', 'Move questions and remove the chapter atomically', { ...write, chapterId: uuid, input }],
  ['list_courses', 'List courses', page], ['list_banks', 'Find question banks by course or name', { ...page, subjectId: uuid.optional() }],
  ['list_chapters', 'List chapters in order', bank], ['get_bank', 'Get bank and current business versions', bank],
  ['list_questions', 'List questions in a bank or chapter', { ...bank, ...page, chapterId: uuid.optional() }],
  ['get_question', 'Read a question, children, answers and revision', { questionId: uuid }],
  ['publication_checks', 'Check publication readiness', bank], ['export_bank', 'Get a short-lived URL to download the complete ZIP', bank],
  ['create_bank', 'Create a draft. Input requires subjectId and name', { input, idempotencyKey: uuid }],
  ['save_chapter', 'Create or edit a chapter. Input contains name, sortOrder and expectedVersion for edits', { ...write, chapterId: uuid.optional(), input }],
  ['reorder_chapters', 'Reorder all chapters using ids and expectedContentVersion', { ...write, input }],
  ['delete_chapter', 'Delete an empty chapter by ID and current version', { ...write, chapterId: uuid, expectedVersion: z.number().int().positive() }],
  ['create_question', 'Create one question or reading group', { ...write, input: question }],
  ['update_question', 'Update a reviewed question after showing differences', { ...write, input: question.extend({ expectedVersion: z.number().int().positive() }), questionId: uuid, confirmed: z.literal(true) }],
  ['upload_image', 'Get a short-lived PUT URL. Send raw image with its Content-Type and use the returned id', bank],
  ['upload_zip', 'Get uploadId and a short-lived URL. PUT each 4 MiB chunk using ?part=0,1,...', { ...bank, sizeBytes: z.number().int().positive() }],
  ['preview_import', 'Preview a staged ZIP. Input includes uploadId and optional chapterMap', { ...bank, input }],
  ['commit_import', 'Commit preview with uploadId, digest, expectedContentVersion, chapterMap and confirmed updates', { ...write, input }],
  ['publish_bank', 'Set publication status with expectedVersion', { ...write, input }],
] as const

const handler = createMcpHandler(({ authInfo }) => {
  if (!authInfo) throw new Error('Missing authenticated grant')
  const server = new McpServer({ name: 'qanda-question-bank', version: '1.0.0' })
  skills.attach(server)
  for (const [name, description, fields] of tools) {
    const required = systemTools.find(([tool]) => tool === name)?.[1] ?? (name === 'publish_bank' ? scopes[2] : /^(list_|get_|publication_checks|export_bank)/.test(name) ? scopes[0] : scopes[1])
    if (!authInfo.scopes.includes(required)) continue
    const tool = 'qanda_' + name
    server.registerTool(tool, { description, inputSchema: z.object(fields) }, async args => {
      const response = await service('/bank-agent/tools/' + tool, { method: 'POST', headers: {
        Authorization: 'Bearer ' + authInfo.token, 'Content-Type': 'application/json',
      }, body: JSON.stringify(args) })
      return { isError: !response.ok, content: [{ type: 'text', text: await response.text() }] }
    })
  }
  return server
})

export async function route(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const origin = request.headers.get('Origin')
  if (origin && origin !== issuer) return new Response(null, { status: 403 })
  if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource/mcp')
    return Response.json({ resource: resource.href, authorization_servers: [issuer], scopes_supported: scopes })
  if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server')
    return Response.json({ issuer, authorization_endpoint: issuer + '/agent-authorize', token_endpoint: issuer + '/bank-agent/token', registration_endpoint: issuer + '/bank-agent/register',
      scopes_supported: scopes, response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] })
  if (path === '/bank-agent/register' && request.method === 'POST') {
    const body = await readBody(request, 16384)
    if (body === null) return new Response(null, { status: 413 })
    const res = await service(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    return res.ok ? Response.json(await res.json(), { status: 201 }) : Response.json({ error: 'invalid_client_metadata' }, { status: 400 })
  }
  if (path === '/bank-agent/token' && request.method === 'POST') {
    const body = await readBody(request, 16384)
    if (body === null) return new Response(null, { status: 413 })
    const result = await service(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    return result.ok ? new Response(result.body, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }) :
      Response.json({ error: 'invalid_grant' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  if (/^\/bank-agent\/files\/[A-Za-z0-9_-]{43}$/.test(path) && ['PUT', 'GET'].includes(request.method)) {
    const body = request.method === 'PUT' ? await readBody(request, 5 * 1024 * 1024) : undefined
    if (body === null) return new Response(null, { status: 413 })
    const res = await service(path + url.search, { method: request.method, headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream' }, body })
    return new Response(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } })
  }
  if (path !== '/mcp') return new Response(null, { status: 404 })
  const auth = request.headers.get('Authorization') || ''
  const denied = () => new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="' + issuer + '/.well-known/oauth-protected-resource/mcp"' } })
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) return denied()
  const identity = await service('/bank-agent/identity', { headers: { Authorization: auth } })
  if (!identity.ok) return identity.status >= 500 ? new Response(null, { status: 503 }) : denied()
  const { clientId, scopes: granted } = await identity.json() as { clientId: string; scopes: string[] }
  return handler.fetch(request, { authInfo: { token: auth.substring(7), clientId, scopes: granted, resource } })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = serve({ hostname: process.env.HOST, port: Number(process.env.PORT || 8090), fetch: route })
  process.once('SIGTERM', () => server.close())
}
