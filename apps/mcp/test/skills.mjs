import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'

test('negotiates tools and reads both skills from the workbench download', async t => {
  const token = 't'.repeat(43)
  const scopes = ['banks:read']
  const questionWrites = []
  const backend = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401).end(); return }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/bank-agent/identity') {
      res.end(JSON.stringify({ clientId: 'test', scopes }))
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
  assert.equal((await route(new Request(url))).status, 401)
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
  const bankId = randomUUID()
  const reading = { questionBankId: bankId, type: 'READING', stem: '', passage: '阅读材料',
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
  for (const skill of skills) {
    const { contents } = await call('resources/read', { uri: skill.uri })
    assert.equal(contents[0].text, Buffer.from(files[skill.frontmatter.name + '/SKILL.md']).toString())
  }
})
