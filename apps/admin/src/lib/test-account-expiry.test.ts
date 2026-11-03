import { describe, expect, it } from 'vitest'
import { testAccountExpiry, testAccountDate } from './test-account-expiry'

describe('测试账号有效期', () => {
  it('按完整天数推算跨月日期并显示北京时间', () => {
    const expiry = testAccountExpiry(7, Date.parse('2026-01-28T16:30:00Z'))!
    expect(expiry).toBe('2026-02-04T16:30:00.000Z')
    expect(testAccountDate(expiry)).toContain('2026/2/5')
    expect(testAccountExpiry(365, 0)).toBe(new Date(365 * 86400000).toISOString())
  })
  it.each([0, -1, 366, 1.5, NaN, Infinity])('拒绝无效天数 %s', days => expect(testAccountExpiry(days)).toBeNull())
})
