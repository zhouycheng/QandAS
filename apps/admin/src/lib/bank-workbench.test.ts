import { describe, expect, it } from 'vitest'
import { contentFixture } from '../test-fixtures/content'
import { audienceGroups, bankVisibility, getScopeError, groupsToCategories } from './bank-workbench'

describe('题库展示范围与发布预检', () => {
  const data = contentFixture()
  const directory = { colleges: data.colleges, majors: data.majors }
  const bank = { ...data.questionBanks[0], activeQuestionCount: 2 }

  it('多年级范围合并再展开不丢条件，并消除重复条件', () => {
    const categories = [{ majorId: 'major-computer-science', grade: 2 }, { majorId: 'major-computer-science', grade: 1 }]
    const groups = audienceGroups(categories, directory)
    expect(groups).toHaveLength(1)
    expect(groups[0].grades).toEqual([2, 1])
    const restored = groupsToCategories([...groups, ...groups])
    expect(restored).toHaveLength(2)
    expect(restored.every((a) => a.collegeId === 'college-computer-science')).toBe(true)
    expect(restored.map((a) => a.grade)).toEqual([2, 1])
    expect(groupsToCategories([{ id: 'empty', grades: [] }])).toEqual([])
  })

  it('同一范围的不限年级条件不会被合并成限定年级', () => {
    for (const categories of [[{ majorId: 'major-english' }, { majorId: 'major-english', grade: 2 }], [{ majorId: 'major-english', grade: 2 }, { majorId: 'major-english' }]]) {
      expect(groupsToCategories(audienceGroups(categories, directory))).toEqual([{ collegeId: 'college-foreign-languages', majorId: 'major-english' }])
    }
  })

  it('分类来自目录，空分类是通用题库', () => {
    expect(getScopeError([], directory)).toBeUndefined()
    expect(getScopeError([{}], directory)).toContain('至少填写')
    expect(getScopeError([{ majorId: 'major-english', grade: 6 }], directory)).toContain('年级')
    expect(getScopeError([{ majorId: 'major-english', grade: 2 }], directory)).toBeUndefined()
  })

  it('学院、专业和年级同时匹配，多条展示范围满足任意一条', () => {
    const targeted = { ...bank, categories: [{ collegeId: 'college-computer-science', majorId: 'major-computer-science', grade: 2 }, { majorId: 'major-english', grade: 1 }] }
    expect(bankVisibility(targeted, { collegeId: 'college-computer-science', majorId: 'major-computer-science', grade: 2 }, data.subjects).visible).toBe(true)
    expect(bankVisibility(targeted, { collegeId: 'college-computer-science', majorId: 'major-computer-science', grade: 3 }, data.subjects).visible).toBe(false)
    expect(bankVisibility(targeted, { majorId: 'major-english', grade: 1 }, data.subjects).visible).toBe(true)
    expect(bankVisibility(targeted, {}, data.subjects).visible).toBe(true)
  })

  it('筛选只影响分类匹配，发布状态和课程停用决定公开目录', () => {
    const user = { collegeId: 'college-computer-science', majorId: 'major-computer-science', grade: 2 }
    expect(bankVisibility(bank, user, data.subjects).visible).toBe(true)
    expect(bankVisibility(bank, { ...user, majorId: 'major-english' }, data.subjects).visible).toBe(false)
    expect(user.grade).toBe(2)
    expect(bankVisibility({ ...bank, categories: [] }, {}, data.subjects).visible).toBe(true)
    expect(bankVisibility({ ...bank, publicationStatus: 'DRAFT' }, user, data.subjects)).toMatchObject({ matches: true, visible: false })
    expect(bankVisibility({ ...bank, publicationStatus: 'UNPUBLISHED' }, user, data.subjects).visible).toBe(false)
    expect(bankVisibility(bank, user, data.subjects.map((s) => ({ ...s, status: 'INACTIVE' }))).visible).toBe(false)
  })

})
