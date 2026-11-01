import type { StreamStatus, SyncSnapshot } from '../types/monitoring'
import { ApiError } from './api-error'

// Reconnecting starts with the latest snapshot rather than replaying obsolete metrics.
export function watchSyncStream(fetcher: typeof fetch, url: string, token: () => string, onSnapshot: (data: SyncSnapshot) => void, onStatus: (status: StreamStatus) => void) {
  let stopped = false, controller: AbortController, retry: ReturnType<typeof setTimeout>, idle: ReturnType<typeof setTimeout>, failures = 0
  const identity = token()
  const stop = () => { stopped = true; clearTimeout(retry); clearTimeout(idle); controller?.abort() }
  const connect = async () => {
    if (stopped) return
    if (identity !== token()) { stop(); return }
    controller = new AbortController()
    const keepAlive = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), 25000) }
    onStatus(failures ? 'RECONNECTING' : 'CONNECTING'); keepAlive()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetcher(url, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${identity}`, 'X-Request-Id': crypto.randomUUID() }, signal: controller.signal })
      if (!response.ok) throw new ApiError('监控连接失败', '', response.status, '', Number(response.headers.get('Retry-After')) || undefined)
      if (!response.headers.get('Content-Type')?.includes('text/event-stream') || !response.body) throw new Error('监控流格式无效')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = '', event = '', data: string[] = []
      while (!stopped) {
        const chunk = await reader.read()
        if (stopped) return
        if (identity !== token()) { stop(); return }
        if (chunk.done) throw new Error('监控连接已断开')
        keepAlive(); buffer += decoder.decode(chunk.value, { stream: true })
        if (buffer.length + data.join('\n').length > 65536) throw new Error('监控事件过大')
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1)
          if (!line) {
            if (event === 'auth-expired') throw new ApiError('监控权限已失效', 'AUTH_EXPIRED', 401, '')
            if (event === 'sync-health' && data.length) {
              const value = JSON.parse(data.join('\n')) as SyncSnapshot
              if (!value.metrics || Object.keys(value.metrics).length !== 10 || !Object.values(value.metrics).every(n => n === null || typeof n === 'number' && Number.isFinite(n) && n >= 0)
                || !['HEALTHY', 'SAMPLING', 'RESET', 'STALE', 'UNAVAILABLE'].includes(value.status) || value.windowSeconds !== 60 || !Number.isFinite(Date.parse(value.checkedAt))
                || value.sampledAt !== null && !Number.isFinite(Date.parse(value.sampledAt))) throw new Error('监控快照格式无效')
              failures = 0; onStatus('LIVE'); onSnapshot(value)
            }
            event = ''; data = []
          } else if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
      }
    } catch (error) {
      if (stopped) return
      if (identity !== token()) { stop(); return }
      if (error instanceof ApiError && [401, 403].includes(error.status)) { stop(); onStatus('AUTH_EXPIRED'); return }
      onStatus('RECONNECTING')
      const backoff = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) * (0.75 + Math.random() * 0.25)
      const wait = error instanceof ApiError && error.retryAfterSeconds ? Math.max(backoff, error.retryAfterSeconds * 1000) : backoff
      retry = setTimeout(() => { void connect() }, wait)
    } finally { clearTimeout(idle); controller.abort(); await reader?.cancel().catch(() => {}) }
  }
  void connect()
  return stop
}
