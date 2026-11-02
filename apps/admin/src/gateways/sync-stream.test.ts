import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchSyncStream } from './sync-stream'
import { monitoringSnapshot } from '../../playground/scenarios/monitoring'

const encoder = new TextEncoder()
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), send: (text: string) => controller.enqueue(encoder.encode(text)), close: () => controller.close() }
}
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('监控 SSE', () => {
  it('携带认证头，拼接分片和多行事件，关闭后停止更新', async () => {
    const wire = stream(), snapshot = vi.fn(), status = vi.fn(), value = monitoringSnapshot()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(wire.response)
    const stop = watchSyncStream(fetcher, '/sync', () => 'admin', snapshot, status)
    await drain()
    wire.send(': keepalive\r\nevent: sync-'); wire.send('health\r\ndata: ' + JSON.stringify(value) + '\r\n\r\n')
    await drain()
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(value)
    expect(status).toHaveBeenLastCalledWith('LIVE')
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer admin', Accept: 'text/event-stream' })
    stop(); wire.send('event: sync-health\ndata: ' + JSON.stringify(value) + '\n\n')
    await drain()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it('断线按退避重连，限流遵守等待时间，停止后不再连接', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0)
    const wire = stream(), fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '12' } })).mockResolvedValue(wire.response)
    const stop = watchSyncStream(fetcher, '/sync', () => 'admin', vi.fn(), vi.fn())
    await drain(); await vi.advanceTimersByTimeAsync(749); expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(11999); expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(3)
    stop(); await vi.advanceTimersByTimeAsync(60000); expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('权限失效和切换账号停止订阅，旧账号快照不会进入页面', async () => {
    for (const denied of [401, 403]) {
      const status = vi.fn(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: denied }))
      const stop = watchSyncStream(fetcher, '/sync', () => 'admin', vi.fn(), status)
      await drain(); expect(status).toHaveBeenLastCalledWith('AUTH_EXPIRED'); stop()
    }
    const wire = stream(), snapshot = vi.fn(), status = vi.fn(); let token = 'old'
    const stop = watchSyncStream(vi.fn<typeof fetch>().mockResolvedValue(wire.response), '/sync', () => token, snapshot, status)
    await drain(); token = 'new'; wire.send('event: sync-health\ndata: ' + JSON.stringify(monitoringSnapshot()) + '\n\n')
    await drain(); expect(snapshot).not.toHaveBeenCalled(); stop()
    const expired = stream(), stopExpired = watchSyncStream(vi.fn<typeof fetch>().mockResolvedValue(expired.response), '/sync', () => 'admin', snapshot, status)
    await drain(); expired.send('event: auth-expired\ndata: {}\n\n'); await drain()
    expect(status).toHaveBeenLastCalledWith('AUTH_EXPIRED'); stopExpired()
  })
  it('事件异常进入重连，保留上次有效快照', async () => {
    vi.useFakeTimers()
    const wire = stream(), snapshot = vi.fn(), status = vi.fn()
    const stop = watchSyncStream(vi.fn<typeof fetch>().mockResolvedValue(wire.response), '/sync', () => 'admin', snapshot, status)
    await drain(); wire.send('event: sync-health\ndata: {}\n\n'); await drain()
    expect(snapshot).not.toHaveBeenCalled(); expect(status).toHaveBeenLastCalledWith('RECONNECTING'); stop()
  })
  it('25 秒静默取消连接，负数速率被拒绝', async () => {
    vi.useFakeTimers()
    const status = vi.fn(), snapshot = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, options) => {
      const body = new ReadableStream<Uint8Array>({ start(controller) { options?.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))) } })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const stop = watchSyncStream(fetcher, '/sync', () => 'admin', snapshot, status)
    await drain(); await vi.advanceTimersByTimeAsync(25000)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(status).toHaveBeenLastCalledWith('RECONNECTING'); stop()
    const wire = stream(), invalid = monitoringSnapshot(); invalid.metrics.productionPerSecond = -1
    const stopInvalid = watchSyncStream(vi.fn<typeof fetch>().mockResolvedValue(wire.response), '/sync', () => 'admin', snapshot, status)
    await drain(); wire.send('event: sync-health\ndata: ' + JSON.stringify(invalid) + '\n\n'); await drain()
    expect(snapshot).not.toHaveBeenCalled(); expect(status).toHaveBeenLastCalledWith('RECONNECTING'); stopInvalid()
  })
})
