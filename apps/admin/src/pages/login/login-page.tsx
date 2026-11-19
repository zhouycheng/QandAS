import { useState } from 'react'
import { Button, Checkbox, Form, Input, Message } from '@arco-design/web-react'
import { IconEye, IconEyeInvisible } from '@arco-design/web-react/icon'
import { useMutation } from '@tanstack/react-query'
import { Navigate, useLocation } from 'react-router-dom'
import { useAdminGateway } from '../../gateways/gateway-context'
import { isAuthenticated, saveAdminSession } from '../../lib/auth'
import appIcon from '../../assets/app-icon.jpg'
import { LoginDots } from './login-dots'

interface LoginValues {
  username: string
  password: string
}
export function LoginPage() {
  const gateway = useAdminGateway()
  const location = useLocation()
  const [remember, setRemember] = useState(Boolean(localStorage.getItem('qanda-admin-remember')))
  const [showPassword, setShowPassword] = useState(false)
  const signIn = useMutation({
    mutationFn: async (values: LoginValues) => ({
      account: await gateway.loginAdmin(values.username.trim(), values.password),
      username: values.username.trim(),
    }),
    onSuccess: ({ account, username }) => {
      saveAdminSession(account)
      if (remember) localStorage.setItem('qanda-admin-remember', username)
      else localStorage.removeItem('qanda-admin-remember')
    },
    onError: (error) => Message.error(error.message),
  })
  if (isAuthenticated()) {
    const from = signIn.isSuccess ? location.state?.from : undefined
    const target = typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && from !== '/login'
      ? from : '/dashboard'
    return <Navigate to={target} replace />
  }
  return (
    <main className="login-page">
      <LoginDots />
      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand">
          <img className="brand-logo" src={appIcon} alt="" />
          <span>题小搭</span>
        </div>
        <h1 id="login-title">管理端登录</h1>
        <Form
          layout="vertical"
          requiredSymbol={false}
          onSubmit={(values) => signIn.mutate(values)}
          initialValues={{ username: localStorage.getItem('qanda-admin-remember') ?? '', password: '' }}
        >
          <Form.Item
            field="username"
            label="管理员账号"
            rules={[{ required: true, message: '请输入管理员账号' }]}
          >
            <Input name="username" autoComplete="username" aria-required="true" size="large" />
          </Form.Item>
          <Form.Item
            field="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              aria-required="true"
              size="large"
              suffix={
                <Button
                  type="text"
                  size="mini"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  icon={showPassword ? <IconEye /> : <IconEyeInvisible />}
                  onClick={(event) => {
                    event.stopPropagation()
                    setShowPassword(!showPassword)
                  }}
                />
              }
            />
          </Form.Item>
          <Checkbox checked={remember} onChange={setRemember}>
            记住账号
          </Checkbox>
          <Button type="primary" htmlType="submit" long size="large" loading={signIn.isPending}>
            登录
          </Button>
        </Form>
      </section>
    </main>
  )
}
