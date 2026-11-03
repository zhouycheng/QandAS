export function testAccountExpiry(validDays: number, now = Date.now()) {
  return Number.isInteger(validDays) && validDays >= 1 && validDays <= 365
    ? new Date(now + validDays * 86400000).toISOString() : null
}
export function testAccountDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
