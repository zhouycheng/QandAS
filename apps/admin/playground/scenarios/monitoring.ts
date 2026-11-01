import type { SyncSnapshot, SystemHealth } from '../../src/types/monitoring'

export function monitoringSnapshot(deadLetters = 1): SyncSnapshot {
  const now = new Date().toISOString()
  return { sampledAt: now, checkedAt: now, windowSeconds: 60, status: 'HEALTHY', reason: null,
    metrics: { queued: 12, processing: 4, productionPerSecond: 8.2, consumptionPerSecond: 8, committedPerSecond: 7.8, retrying: 1, deadLetters, consumers: 4, averageLatencyMs: 120, p95LatencyMs: 240 } }
}
export function monitoringHealth(deadLetters = 1): SystemHealth {
  return { sampledAt: new Date().toISOString(), components: ['api', 'worker', 'monitor', 'rabbitmq'].map(name => ({ name, status: 'UP' })),
    endpoints: [{ method: 'POST', path: '/api/v1/practice/sessions/{id}/progress-commands', requestsPerSecond: 8.2, errorsPerSecond: 0, p95Seconds: 0.12 }], activityPending: 2, mailPending: 0, sync: monitoringSnapshot(deadLetters) }
}
