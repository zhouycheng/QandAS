export function communityGroupDate(date: Date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

export function defaultCommunityGroupExpiry(now = new Date()) {
  const date = new Date(now)
  date.setUTCDate(date.getUTCDate() + 7)
  return communityGroupDate(date)
}

export function communityGroupExpiryAt(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const expiry = new Date(`${date}T23:59:59.999+08:00`)
  return Number.isFinite(expiry.getTime()) && communityGroupDate(expiry) === date
    ? expiry.toISOString()
    : null
}
