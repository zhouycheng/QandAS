import type { ManagedUser } from '../types/operations'
export const userFixtures: ManagedUser[] = ['林', '陈', '周', '许', '王', '赵'].map((surname, i) => ({
  version: 1,
  id: `user-${i + 1}`,
  name: `${surname}同学`,
  account: ['A103', 'A104', 'A105', 'B208', 'C016', 'B317'][i],
  email: `student${i + 1}@example.cn`,
  wechatBound: i % 3 !== 0,
  collegeId: i === 4 ? '' : i === 5 ? 'college-foreign-languages' : 'college-computer-science',
  majorId:
    i === 4
      ? ''
      : i === 5
        ? 'major-english'
        : i % 2
          ? 'major-software-engineering'
          : 'major-computer-science',
  grade: i === 4 ? undefined : i % 2 ? 3 : 2,
  registeredAt: `2026-10-${String(10 + i).padStart(2, '0')}T08:00:00Z`,
  status: i === 3 ? 'DISABLED' : 'ACTIVE',
  answeredCount: [1248, 856, 2315, 412, 1892, 298][i],
  activeDays: [28, 25, 27, 18, 26, 12][i],
  preferredHours: ['19:00–21:00', '20:00–22:00', '18:00–20:00'][i % 3],
  lastActiveAt: `2026-10-2${5 - i}T01:15:00.000Z`,
}))
