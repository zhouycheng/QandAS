import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineChart } from './charts'

describe('实时速率图', () => {
  it('保留首尾时间且最多显示五个刻度，消费峰值处于绘图区内', () => {
    const data = Array.from({ length: 60 }, (_, i) => ({ label: `12:${String(i).padStart(2, '0')}:00`, value: 1, secondary: 40 }))
    const svg = renderToStaticMarkup(<LineChart data={data} label="速率" />)
    expect(svg.match(/y="246"/g)).toHaveLength(5)
    expect(svg).toContain('>12:00:00</text>')
    expect(svg).toContain('>12:59:00</text>')
    expect(svg).not.toMatch(/points="[^"]*,\-/)
    expect(svg).toContain('>40</text>')
  })
})
