import { ManagementDrawer as Drawer } from '../components/management-drawer'
import { useEffect, useState } from 'react'
import { Avatar, Button, Message, Space } from '@arco-design/web-react'
import {
  IconBook, IconDashboard, IconDesktop, IconExperiment, IconHistory, IconIdcard,
  IconMenuFold, IconMenuUnfold, IconMessage, IconMindMapping, IconNotification, IconPoweroff,
  IconSafe, IconUser, IconUserGroup,
} from '@arco-design/web-react/icon'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { getAdminSession, isAuthenticated, logout, touchAdminSession } from '../lib/auth'
import { useUiStore } from '../stores/ui-store'
import { useAdminGateway } from '../gateways/gateway-context'
import appIcon from '../assets/app-icon.jpg'

const groups = [
  { title: '教学内容', items: [['/question-banks', '题库工作台', IconBook], ['/colleges', '院级管理', IconMindMapping]] },
  { title: '用户与账号', items: [['/users', '用户管理', IconUserGroup], ['/test-accounts', '测试账号管理', IconExperiment]] },
  { title: '运营', items: [['/dashboard', '运营概览', IconDashboard], ['/feedback', '学生反馈', IconMessage], ['/announcements', '公告与社群', IconNotification]] },
  { title: '系统', items: [['/monitoring', '系统监控', IconDesktop], ['/administrators', '管理员账号', IconIdcard], ['/security', '安全与 Agent', IconSafe], ['/compatibility', '历史版本管理', IconBook], ['/logs', '操作日志', IconHistory]] },
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
  const pathname = location.pathname.replace(/\/+$/, '')
  const activePath = pathname === '/community-group' ? '/announcements' : pathname
  const navigation = (
    <>
      <Link className="brand" to="/dashboard" aria-label="题小搭" title="题小搭">
        <img className="brand-logo" src={appIcon} alt="" />
        <span className="brand-label">题小搭</span>
      </Link>
      <nav aria-label="管理导航">
        {groups.map((group) => (
          <div className="nav-group" key={group.title}>
            <div className="nav-group-title"><span>{group.title}</span></div>
            {group.items.map(([path, label, Icon]) => (
              <Link
                className={`nav-link ${activePath === path || activePath.startsWith(path + '/') ? 'active' : ''}`}
                key={path}
                title={label}
                to={path}
                aria-current={activePath === path || activePath.startsWith(path + '/') ? 'page' : undefined}
                onClick={() => {
                  if (mobile) setCollapsed(true)
                }}
              >
                <Icon className="nav-icon" aria-hidden="true" />
                <span className="nav-label">{label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">学生共建 · 高效复习</div>
    </>
  )
  const bankDetail = pathname.startsWith('/question-banks/')
  const pageName = pathname === '/agent-authorize' ? 'Agent 授权' : pageNames[activePath]
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
            {bankDetail
              ? <nav aria-label="当前位置" className="bank-breadcrumb"><Link aria-label="返回课程题库" to={{ pathname: '/question-banks', search: location.state?.listSearch }}>题库工作台</Link><span aria-hidden="true">/</span><span className="admin-page-title" aria-current="page">题库详情</span></nav>
              : <h1 className="admin-page-title">{pageName}</h1>}
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
        <footer className="environment-bar">题小搭 V1.0.0</footer>
      </div>
    </div>
  )
}
