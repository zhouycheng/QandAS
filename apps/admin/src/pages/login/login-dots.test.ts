import { expect, it } from 'vitest'
import { dotOffset } from './login-dots'

it('波点沿鼠标方向偏移，距离衰减，退出时归位', () => {
  const near = dotOffset(48, -24, 198, 1)
  expect(near.x).toBeGreaterThan(0)
  expect(near.y).toBeCloseTo(-near.x / 2)
  expect(dotOffset(-48, 24, 198, 1).x).toBeCloseTo(-near.x)
  expect(dotOffset(140, -24, 198, 1).weight).toBeLessThan(near.weight)
  expect(dotOffset(198, 0, 198, 1)).toEqual({ x: 0, y: 0, weight: 0 })
  expect(dotOffset(48, 24, 198, 0.5).x).toBeCloseTo(near.x / 2)
  expect(dotOffset(48, 24, 198, 0)).toEqual({ x: 0, y: 0, weight: 0 })
})
