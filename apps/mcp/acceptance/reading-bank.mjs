import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { zipSync, strToU8 } from 'fflate'
import { route } from '../dist/server.js'

// The PostgreSQL fixture supplies a real draft-only OAuth access token and disposable bank.
const token = process.env.QANDA_TEST_TOKEN
const bankId = process.env.QANDA_TEST_BANK
const url = new URL(process.env.QANDA_MCP_RESOURCE)
const listener = serve({ hostname: '127.0.0.1', port: 0, fetch: route })
await once(listener, 'listening')
const origin = 'http://127.0.0.1:' + listener.address().port
async function call(method, params = {}) {
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'bank-acceptance', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/skills': {} } } }
  const name = params.uri || params.name
  const res = await fetch(origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) })
  const data = await res.json()
  assert.ok(data.result, JSON.stringify(data.error))
  return data.result
}
async function tool(name, args) {
  const result = await call('tools/call', { name: 'qanda_' + name, arguments: name === 'get_question' ? args : { ...args, bankId } })
  assert.ok(!result.isError, result.content[0].text)
  return JSON.parse(result.content[0].text)
}
function localFile(address) {
  const path = new URL(address)
  assert.equal(path.origin, url.origin)
  return origin + path.pathname
}
async function stage(bytes) {
  const upload = await tool('upload_zip', { sizeBytes: bytes.length })
  assert.equal((await fetch(localFile(upload.url) + '?part=0', { method: 'PUT', body: bytes })).status, 204)
  return { uploadId: upload.uploadId }
}
try {
  const skills = (await call('skills/list')).skills
  for (const name of ['qanda-question-bank-mcp', 'qanda-question-bank']) {
    const skill = skills.find(x => x.frontmatter.name === name)
    const body = (await call('resources/read', { uri: skill.uri })).contents[0].text
    assert.ok(body.includes('qanda-question-bank'))
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64')
  const image = await tool('upload_image', {})
  const upload = await fetch(localFile(image.url), { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png })
  const result = await upload.json()
  assert.equal(upload.status, 200, JSON.stringify(result))
  const imageId = result.id
  const root = randomUUID(), child = randomUUID()
  const input = { questionBankId: bankId, portableId: root, type: 'READING', stem: '图形练习', contentFormat: 'MARKDOWN',
    passage: '观察示例 ![原图](asset:' + imageId + ')。', assetIds: [imageId],
    subQuestions: [{ portableId: child, type: 'TRUE_FALSE', stem: '示例中提供了图片。', correctValue: true, explanation: '材料中有一张示意图。' }] }
  const saved = await tool('create_question', { idempotencyKey: randomUUID(), input })
  assert.equal(saved.portableId, root)
  assert.equal(saved.subQuestions[0].portableId, child)
  const download = await tool('export_bank', {})
  const original = await fetch(localFile(download.url))
  assert.equal(original.status, 200)
  const same = await stage(new Uint8Array(await original.arrayBuffer()))
  const preview = await tool('preview_import', { input: same })
  assert.ok(preview.changes.every(x => x.action === 'SKIP'))
  const doc = { format: 'qanda-question-bank', version: '1.0', bank: { name: '图形练习', description: '' }, sources: [], chapters: [],
    assets: [{ id: 'fig', path: 'assets/images/fig.png' }], questions: [{ id: root, type: 'READING', stem: '修订后的图形练习', contentFormat: 'MARKDOWN',
      passage: '观察示例 ![原图](asset:fig)。', subQuestions: [{ id: child, type: 'TRUE_FALSE', stem: input.subQuestions[0].stem, correctValue: true, explanation: input.subQuestions[0].explanation }] }] }
  const change = await stage(zipSync({ 'bank.json': strToU8(JSON.stringify(doc)), 'assets/images/fig.png': png }))
  const review = await tool('preview_import', { input: change })
  assert.equal(review.changes[0].action, 'UPDATE')
  assert.deepEqual(review.changes[0].differences.stem, [input.stem, doc.questions[0].stem])
  await tool('commit_import', { idempotencyKey: randomUUID(), input: { ...change, expectedContentVersion: review.contentVersion, digest: review.digest, confirmUpdates: true } })
  const updated = await tool('get_question', { questionId: saved.id })
  assert.equal(updated.stem, doc.questions[0].stem)
  assert.notEqual(updated.revisionId, saved.revisionId)
  process.stdout.write(saved.id)
} finally {
  listener.closeAllConnections()
  listener.close()
}
