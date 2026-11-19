import { Radio } from '@arco-design/web-react'
import type { ActivityQuery } from '../../types/operations'

export type ActivityPeriod = NonNullable<ActivityQuery['period']>
export const periodLabels = {
  DAY: '今日', WEEK: '近 7 天', MONTH: '近 30 天', ALL: '累计',
} satisfies Record<ActivityPeriod, string>

export function ActivityPeriodSelect({ name, label, value, onChange }: {
  name: string
  label: string
  value: ActivityPeriod
  onChange: (period: ActivityPeriod) => void
}) {
  return <Radio.Group className="ops-segments" type="button" name={name} aria-label={label} value={value} onChange={onChange}>
    {Object.entries(periodLabels).map(([key, text]) => <Radio key={key} value={key}>{text}</Radio>)}
  </Radio.Group>
}
