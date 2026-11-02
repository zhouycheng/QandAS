import type { College } from '../types/admin'

export const collegeFixtures: College[] = [
  {
    version: 1,
    id: 'college-computer-science',
    name: '计算机学院',
    code: 'CS',
    status: 'ACTIVE',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    version: 1,
    id: 'college-foreign-languages',
    name: '外国语学院',
    code: 'FL',
    status: 'ACTIVE',
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
  },
]
