import type { SyncSnapshot } from '../types/monitoring'

export function monitoringSnapshot(deadLetters = 1): SyncSnapshot {
  const now = new Date().toISOString()
  return { sampledAt: now, checkedAt: now, windowSeconds: 60, status: 'HEALTHY', reason: null,
    metrics: { queued: 12, processing: 4, productionPerSecond: 8.2, consumptionPerSecond: 8, committedPerSecond: 7.8, retrying: 1, deadLetters, consumers: 4, averageLatencyMs: 120, p95LatencyMs: 240 } }
}
