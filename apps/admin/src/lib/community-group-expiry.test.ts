import { describe, expect, it } from 'vitest'
import { communityGroupDate, communityGroupExpiryAt, defaultCommunityGroupExpiry } from './community-group-expiry'

describe('交流群二维码有效日期', () => {
  it('按北京时间自动填入七天后，跨月和跨年保持正确', () => {
    expect(defaultCommunityGroupExpiry(new Date('2026-11-03T04:30:00Z'))).toBe('2026-11-10')
    expect(defaultCommunityGroupExpiry(new Date('2026-11-03T16:30:00Z'))).toBe('2026-11-11')
    expect(defaultCommunityGroupExpiry(new Date('2026-12-28T04:30:00Z'))).toBe('2027-01-04')
    expect(defaultCommunityGroupExpiry(new Date('2028-02-23T04:30:00Z'))).toBe('2028-03-01')
  })

  it('所选日期当天结束时到期，读回仍为同一天', () => {
    expect(communityGroupExpiryAt('2026-11-10')).toBe('2026-11-10T15:59:59.999Z')
    expect(communityGroupDate(new Date('2026-11-10T15:59:59.999Z'))).toBe('2026-11-10')
    expect(communityGroupExpiryAt('2028-02-29')).toBe('2028-02-29T15:59:59.999Z')
  })

  it('空值、时间文本和不存在的日期不能保存', () => {
    for (const date of ['', '2026-11-10T12:30', '2026-02-29', '2026-13-01', 'invalid']) {
      expect(communityGroupExpiryAt(date)).toBeNull()
    }
  })
})
