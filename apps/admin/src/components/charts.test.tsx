import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineChart } from './charts'

describe('实时速率图', () => {
  it('保留首尾时间且最多显示五个刻度，消费峰值处于绘图区内', () => {
    const data = Array.from({ length: 60 }, (_, i) => ({ label: `12:${String(i).padStart(2, '0')}:00`, value: 1, secondary: 40 }))
    const svg = renderToStaticMarkup(<LineChart data={data} label="速率" />)
    expect(svg.match(/>12:\d\d:00<\/text>/g)).toHaveLength(5)
    expect(svg).toContain('>12:00:00</text>')
    expect(svg).toContain('>12:59:00</text>')
    expect(svg).not.toMatch(/points="[^"]*,\-/)
    expect(svg).toContain('>40</text>')
  })
})

it('宽幅活跃图在零值时保留覆盖整个时段的基线和日期', () => {
  const svg = renderToStaticMarkup(<LineChart width={800} label="每日活跃人数" data={[
    { label: '2026-11-12', value: 0 }, { label: '2026-11-18', value: 0 },
  ]} />)
  expect(svg).toContain('viewBox="0 0 800 265"')
  expect(svg).toContain('points="16,241 796,241"')
  expect(svg).toContain('text-anchor="start">11-12</text>')
  expect(svg).toContain('text-anchor="end">11-18</text>')
})

it('没有数据时可以保留坐标网格，曲线和点随数据绘制', () => {
  const svg = renderToStaticMarkup(<LineChart width={800} height={200} showEmptyAxes label="每日活跃人数" data={[]}>加载中…</LineChart>)
  expect(svg.match(/<line /g)).toHaveLength(5)
  expect(svg).toContain('x1="16" y1="192" x2="796" y2="192"')
  expect(svg).toContain('left:50.75%;top:51%')
  expect(svg).not.toMatch(/<polyline|<circle/)
})
