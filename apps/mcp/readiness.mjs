const resource = new URL(process.env.QANDA_MCP_RESOURCE)
const local = 'http://127.0.0.1:' + (process.env.PORT || 8090)
const api = process.env.QANDA_API_UPSTREAM
async function get(base, path) {
  const response = await fetch(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(3500) })
  if (!response.ok) throw new Error('Readiness check failed at ' + path)
  return response.json()
}
const [metadata, backend, health] = await Promise.all([
  get(local, '/.well-known/oauth-protected-resource/mcp'),
  get(api, '/bank-agent/resource'),
  get(api, '/api/v1/health'),
])
if (metadata.resource !== resource.href || backend.resource !== resource.href || health.status !== 'UP') {
  throw new Error('MCP resource or upstream health does not match')
}
