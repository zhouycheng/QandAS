import { useEffect, useState } from 'react'
import { Avatar, Breadcrumb, Button, Drawer, Message, Space } from '@arco-design/web-react'
import { IconMenuFold, IconMenuUnfold, IconPoweroff, IconUser } from '@arco-design/web-react/icon'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { getAdminSession, isAuthenticated, logout, touchAdminSession } from '../lib/auth'
import { useUiStore } from '../stores/ui-store'
import { useAdminGateway } from '../gateways/gateway-context'
import { DesignIcon } from '../components/design-icon'

const groups = [
  {
    title: '工作台',
    items: [
      ['/dashboard', '运营概览', 'dashboard'],
      ['/activity', '活跃度监控', 'activity'],
      ['/monitoring', '系统监控', 'activity'],
      ['/colleges', '院级管理', 'college'],
      ['/question-banks', '题库工作台', 'book'],
      ['/feedback', '学生反馈', 'file'],
      ['/announcements', '公告管理', 'announcement'],
      ['/users', '用户管理', 'users'],
    ],
  },
  {
    title: '设置',
    icon: 'settings',
    items: [
      ['/administrators', '管理员账号', 'shield'],
      ['/security', '安全规则', 'settings'],
      ['/community-group', '交流群二维码', 'users'],
      ['/logs', '操作日志', 'file'],
    ],
  },
] as const
const pageNames: Record<string, string> = Object.fromEntries(
  groups.flatMap((g) => g.items.map(([path, name]) => [path, name])),
)
export function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const gateway = useAdminGateway()
  const { collapsed, setCollapsed } = useUiStore()
  const [mobile, setMobile] = useState(window.innerWidth <= 760)
  const timeoutMinutes = getAdminSession()?.timeoutMinutes ?? 30
  const session = getAdminSession()
  useEffect(() => {
    if (mobile) setCollapsed(true)
  }, [mobile, setCollapsed])
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth <= 760)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    let lastTouch = 0
    const check = () => {
      if (!isAuthenticated()) {
        logout()
        queryClient.clear()
        navigate('/login', { replace: true })
        return
      }
      const current = getAdminSession()!
      timer = setTimeout(
        check,
        Math.max(100, current.timeoutMinutes * 60000 - (Date.now() - current.lastActivity)),
      )
    }
    const activity = () => {
      if (!isAuthenticated()) {
        check()
        return
      }
      if (Date.now() - lastTouch < 1000) return
      lastTouch = Date.now()
      touchAdminSession(timeoutMinutes)
      clearTimeout(timer)
      check()
    }
    check()
    const storage = () => {
      clearTimeout(timer)
      check()
    }
    window.addEventListener('pointerdown', activity)
    window.addEventListener('keydown', activity)
    window.addEventListener('storage', storage)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', activity)
      window.removeEventListener('keydown', activity)
      window.removeEventListener('storage', storage)
    }
  }, [navigate, timeoutMinutes])
  const navigation = (
    <>
      <Link className="brand" to="/dashboard">
        QandA
      </Link>
      <nav aria-label="管理导航">
        {groups.map((group) => (
          <div className="nav-group" key={group.title}>
            <div className="nav-group-title"><span>{group.title}</span></div>
            {group.items.map(([path, label, icon]) => (
              <Link
                className={`nav-link ${location.pathname === path || location.pathname.startsWith(path + '/') ? 'active' : ''}`}
                key={path}
                title={label}
                to={path}
                aria-current={location.pathname === path || location.pathname.startsWith(path + '/') ? 'page' : undefined}
                onClick={() => {
                  if (mobile) setCollapsed(true)
                }}
              >
                <DesignIcon name={icon} />
                <span>{label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">学生共建 · 高效复习</div>
    </>
  )
  const pageName = location.pathname.startsWith('/question-banks/') ? '题库工作台' : (pageNames[location.pathname] ?? '管理端')
  return (
    <div className={`admin-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="admin-sider">{navigation}</aside>
      <Drawer
        className="mobile-navigation"
        placement="left"
        width={250}
        visible={!collapsed && mobile}
        footer={null}
        title="管理导航"
        onCancel={() => setCollapsed(true)}
      >
        {navigation}
      </Drawer>
      <div className="admin-main">
        <header className="admin-header">
          <Space>
            <Button
              className="sidebar-toggle"
              type="text"
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              icon={collapsed ? <IconMenuUnfold /> : <IconMenuFold />}
              onClick={() => setCollapsed(!collapsed)}
            />
            <Breadcrumb>
              <Breadcrumb.Item>后台管理</Breadcrumb.Item>
              <Breadcrumb.Item>{pageName}</Breadcrumb.Item>
            </Breadcrumb>
          </Space>
          <Space>
            <Avatar size={34}>
              <IconUser />
            </Avatar>
            <span className="admin-name">{session?.name ?? '管理员'}</span>
            <Button
              type="text"
              icon={<IconPoweroff />}
              aria-label="退出登录"
              onClick={async () => {
                try {
                  await gateway.logoutAdmin()
                  logout()
                  queryClient.clear()
                  navigate('/login', { replace: true })
                } catch (error) { Message.error((error as Error).message) }
              }}
            />
          </Space>
        </header>
        <main className="admin-content">
          <Outlet />
        </main>
        <footer className="environment-bar">QandA V1.0.0</footer>
      </div>
    </div>
  )
}
