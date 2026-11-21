import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'

test('negotiates grants, resolves destinations and serves the workbench skill files', async t => {
  const token = 't'.repeat(43)
  const scopes = ['banks:read']
  const questionWrites = []
  const courses = [{ id: randomUUID(), name: '物理' }, { id: randomUUID(), name: '数学' }]
  const banks = courses.map(course => ({ id: randomUUID(), subjectId: course.id, name: '基础练习' }))
  const chapterId = randomUUID()
  const backend = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401).end(); return }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/bank-agent/identity') {
      res.end(JSON.stringify({ clientId: 'test', scopes }))
    } else if (req.url.startsWith('/bank-agent/tools/qanda_list_')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const args = JSON.parse(Buffer.concat(chunks).toString())
      const page = items => ({ items, total: items.length, page: 1, pageSize: 20 })
      if (req.url.endsWith('list_courses')) res.end(JSON.stringify(page(courses)))
      else if (req.url.endsWith('list_banks')) res.end(JSON.stringify(page(banks.filter(b => b.subjectId === args.subjectId))))
      else if (req.url.endsWith('list_chapters') && args.bankId === banks[1].id) res.end(JSON.stringify([{ id: chapterId, name: '第一章' }]))
      else res.writeHead(404).end()
    } else if (req.method === 'POST' && /^\/bank-agent\/tools\/qanda_(create|update)_question$/.test(req.url)) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      questionWrites.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.end('{}')
    } else {
      res.writeHead(404).end()
    }
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  t.after(() => backend.close())
  process.env.QANDA_API_UPSTREAM = 'http://127.0.0.1:' + backend.address().port
  const { route } = await import('../dist/server.js')
  const url = 'http://localhost:8090/mcp'
  const denied = await route(new Request(url))
  assert.equal(denied.status, 401)
  const metadataUrl = denied.headers.get('WWW-Authenticate').match(/resource_metadata="([^"]+)"/)[1]
  const metadata = await (await route(new Request(metadataUrl))).json()
  const oauth = await (await route(new Request(metadata.authorization_servers[0] + '/.well-known/oauth-authorization-server'))).json()
  assert.equal(new URL(oauth.authorization_endpoint).pathname, '/agent-authorize')
  assert.deepEqual(oauth.code_challenge_methods_supported, ['S256'])
  const tooLarge = new Request(new URL('/bank-agent/files/' + token, url), { method: 'PUT', body: new Uint8Array(5 * 1024 * 1024 + 1) })
  assert.equal((await route(tooLarge)).status, 413)
  async function call(method, params = {}) {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'fixture', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/skills': {} } } }
    const name = params.uri ?? params.name
    const res = await route(new Request(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) }))
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.ok(body.result, JSON.stringify(body))
    return body.result
  }
  const tools = await call('tools/list')
  assert.ok(tools.tools.some(t => t.name === 'qanda_export_bank'))
  assert.ok(!tools.tools.some(t => t.name === 'qanda_create_question'))
  scopes.push('banks:write')
  const writable = (await call('tools/list')).tools
  async function lookup(name, args) {
    const response = await call('tools/call', { name: 'qanda_list_' + name, arguments: args })
    return JSON.parse(response.content[0].text)
  }
  const course = (await lookup('courses', {})).items.find(c => c.name === '数学')
  const { items: candidates } = await lookup('banks', { subjectId: course.id })
  assert.deepEqual(candidates, [banks[1]])
  const bankId = candidates[0].id
  const chapters = await lookup('chapters', { bankId })
  assert.equal(chapters[0].id, chapterId)
  assert.equal(questionWrites.length, 0)
  const reading = { questionBankId: bankId, chapterId, type: 'READING', stem: '', passage: '阅读材料',
    subQuestions: [{ type: 'TRUE_FALSE', stem: '判断正误', correctValue: true }] }
  for (const name of ['qanda_create_question', 'qanda_update_question']) {
    const input = writable.find(t => t.name === name).inputSchema.properties.input
    assert.ok(input.required.includes('stem'))
    assert.equal(input.properties.options.type, 'array')
    const args = { bankId, idempotencyKey: randomUUID(), input: reading }
    if (name === 'qanda_update_question') {
      args.questionId = randomUUID()
      args.confirmed = true
      args.input = { ...reading, expectedVersion: 1 }
    }
    const result = await call('tools/call', { name, arguments: args })
    assert.equal(Boolean(result.isError), false, JSON.stringify(result))
    assert.deepEqual(questionWrites.at(-1), { path: '/bank-agent/tools/' + name, body: args })
  }
  const { skills } = await call('skills/list')
  assert.deepEqual(skills.map(s => s.frontmatter.name).sort(), ['qanda-question-bank', 'qanda-question-bank-mcp', 'qanda-system-admin-mcp'])
  const files = unzipSync(await readFile(new URL('../../admin/public/qanda-bank-skills.zip', import.meta.url)))
  for (const name of ['authorization', 'destination', 'question', 'edit', 'import']) {
    assert.ok(files['qanda-question-bank-mcp/references/' + name + '.md'])
  }
  for (const name of ['human-writing', 'human-prose', 'no-ai-slop', 'no-negative-echo']) {
    const prefix = 'qanda-question-bank/references/writing/' + name
    assert.ok(files[prefix + '/guide.md'])
    assert.ok(files[prefix + '/LICENSE'])
  }
  for (const [path, bytes] of Object.entries(files)) {
    const { contents } = await call('resources/read', { uri: 'skill://' + path })
    const body = contents[0]
    assert.deepEqual(Buffer.from(body.text ?? body.blob, body.text === undefined ? 'base64' : 'utf8'), Buffer.from(bytes), path)
  }
})
