import { Alert, Button, Result } from '@arco-design/web-react'

export function ErrorState({ message, onRetry, stale }: { message: string; onRetry: () => void; stale?: boolean }) {
  if (stale) return <Alert type="warning" content={'更新失败，当前显示上次读取的数据。' + message} action={<Button onClick={onRetry}>重试</Button>} />
  return (
    <Result
      status="error"
      title="加载失败"
      subTitle={message}
      extra={<Button onClick={onRetry}>重新加载</Button>}
    />
  )
}
