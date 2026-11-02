import { Empty } from '@arco-design/web-react'

export function LineChart({
  data,
  percent = false,
  label,
}: {
  data: { label: string; value: number; secondary?: number }[]
  percent?: boolean
  label: string
}) {
  if (!data.length) return <Empty description="暂无统计数据" />
  const max = Math.max(1, ...data.flatMap((d) => [d.value, percent ? 0 : (d.secondary ?? 0)]))
  const ceiling = Math.ceil(max / 4) * 4
  const tickCount = Math.min(5, data.length)
  const ticks = new Set(Array.from({ length: tickCount }, (_, i) => Math.round(i * (data.length - 1) / Math.max(1, tickCount - 1))))
  const x = (i: number) => 48 + (i / Math.max(1, data.length - 1)) * 490
  const y = (n: number, secondary = false) => 220 - (n / (secondary && percent ? 100 : ceiling)) * 180
  const points = (secondary = false) =>
    data.map((d, i) => `${x(i)},${y(secondary ? (d.secondary ?? 0) : d.value, secondary)}`).join(' ')
  return (
    <div className="chart-wrap">
      <svg viewBox="0 0 600 265" role="img" aria-label={label}>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1="48" y1={40 + i * 45} x2="540" y2={40 + i * 45} stroke="#dce8f8" strokeDasharray="5 5" />
            <text x="39" y={44 + i * 45} textAnchor="end">
              {Math.round(ceiling * (1 - i / 4))}
            </text>
            {percent && (
              <text x="550" y={44 + i * 45}>
                {100 - i * 25}%
              </text>
            )}
          </g>
        ))}
        <polyline points={points()} fill="none" stroke="#087bff" strokeWidth="2.5" strokeLinejoin="round" />
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
              <text x={x(i)} y="246" textAnchor="middle">
                {/^\d{4}-\d{2}-\d{2}$/.test(d.label) ? d.label.slice(5) : d.label}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}
