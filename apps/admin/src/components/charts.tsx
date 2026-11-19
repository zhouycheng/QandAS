import { Empty } from '@arco-design/web-react'
import type { ReactNode } from 'react'

export function LineChart({
  data,
  percent = false,
  width = 600,
  height = 265,
  showEmptyAxes = false,
  label,
  children,
}: {
  data: { label: string; value: number; secondary?: number }[]
  showEmptyAxes?: boolean
  width?: number
  height?: number
  percent?: boolean
  label: string
  children?: ReactNode
}) {
  if (!data.length && !showEmptyAxes) return <Empty description="暂无统计数据" />
  const max = Math.max(1, ...data.flatMap((d) => [d.value, percent ? 0 : (d.secondary ?? 0)]))
  const ceiling = Math.ceil(max / 4) * 4
  const tickCount = Math.min(5, data.length)
  const ticks = new Set(Array.from({ length: tickCount }, (_, i) => Math.round(i * (data.length - 1) / Math.max(1, tickCount - 1))))
  const left = Math.max(16, String(ceiling).length * 7 + 8)
  const right = width - (percent ? 40 : 4)
  const top = 12
  const bottom = height - (data.length ? 24 : 8)
  const plotHeight = bottom - top
  const x = (i: number) => data.length === 1 ? (left + right) / 2 : left + i * (right - left) / (data.length - 1)
  const y = (n: number, secondary = false) => bottom - (n / (secondary && percent ? 100 : ceiling)) * plotHeight
  const points = (secondary = false) =>
    data.map((d, i) => `${x(i)},${y(secondary ? (d.secondary ?? 0) : d.value, secondary)}`).join(' ')
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={left} y1={top + i * plotHeight / 4} x2={right} y2={top + i * plotHeight / 4} stroke="#dce8f8" strokeDasharray="5 5" />
            <text x={left - 8} y={top + 4 + i * plotHeight / 4} textAnchor="end">
              {Math.round(ceiling * (1 - i / 4))}
            </text>
            {percent && (
              <text x={right + 8} y={top + 4 + i * plotHeight / 4}>
                {100 - i * 25}%
              </text>
            )}
          </g>
        ))}
        {data.length > 0 && <polyline points={points()} fill="none" stroke="#087bff" strokeWidth="2.5" strokeLinejoin="round" />}
        {data.some((d) => d.secondary !== undefined) && (
          <polyline points={points(true)} fill="none" stroke="#9bc7ff" strokeWidth="2" />
        )}
        {data.map((d, i) => (
          <g key={d.label}>
            <circle cx={x(i)} cy={y(d.value)} r="3" fill="#087bff">
              <title>{`${d.label}：${d.value}${d.secondary !== undefined
                  ? `，${percent ? '正确率' : '对比值'} ${d.secondary}${percent ? '%' : ''}`
                  : ''}`}</title>
            </circle>
            {ticks.has(i) && (
              <text x={x(i)} y={bottom + 18} textAnchor={data.length === 1 ? 'middle' : i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}>
                {/^\d{4}-\d{2}-\d{2}$/.test(d.label) ? d.label.slice(5) : d.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {children && <div className="chart-message" style={{ left: `${100 * ((left + right) / 2) / width}%`, top: `${100 * ((top + bottom) / 2) / height}%` }}>{children}</div>}
    </div>
  )
}
