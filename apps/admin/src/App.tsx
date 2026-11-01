import { lazy, Suspense } from 'react'
import { Spin } from '@arco-design/web-react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AdminLayout } from './layouts/admin-layout'
import { ProtectedRoute } from './components/protected-route'

const DashboardPage = lazy(() =>
  import('./pages/dashboard/dashboard-page').then((module) => ({ default: module.DashboardPage })),
)
const LoginPage = lazy(() =>
  import('./pages/login/login-page').then((module) => ({ default: module.LoginPage })),
)
const CollegesPage = lazy(() =>
  import('./pages/colleges/colleges-page').then((module) => ({ default: module.CollegesPage })),
)
const QuestionBanksPage = lazy(() =>
  import('./pages/question-banks/question-banks-page').then((module) => ({ default: module.QuestionBanksPage })),
)
const BankWorkspacePage = lazy(() =>
  import('./pages/question-banks/bank-workspace-page').then((module) => ({ default: module.BankWorkspacePage })),
)
const ActivityPage = lazy(() => import('./pages/activity/activity-page').then(m => ({ default: m.ActivityPage })))
const MonitoringPage = lazy(() => import('./pages/monitoring/monitoring-page').then(m => ({ default: m.MonitoringPage })))
const UsersPage = lazy(() => import('./pages/operations/operations-pages').then(m => ({ default: m.UsersPage })))
const FeedbackPage = lazy(() => import('./pages/operations/operations-pages').then(m => ({ default: m.FeedbackPage })))
const AnnouncementsPage = lazy(() => import('./pages/operations/operations-pages').then(m => ({ default: m.AnnouncementsPage })))
const AdministratorsPage = lazy(() => import('./pages/operations/operations-pages').then(m => ({ default: m.AdministratorsPage })))
const SecurityPage = lazy(() => import('./pages/operations/operations-pages').then(m => ({ default: m.SecurityPage })))
const LogsPage = lazy(() => import('./pages/operations/operations-pages').then(m => ({ default: m.LogsPage })))

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="page-loading">
          <Spin size={36} />
        </div>
      }
    >
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <ProtectedRoute>
              <AdminLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/monitoring" element={<MonitoringPage />} />
          <Route path="/colleges" element={<CollegesPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/announcements" element={<AnnouncementsPage />} />
          <Route path="/administrators" element={<AdministratorsPage />} />
          <Route path="/security" element={<SecurityPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/question-banks" element={<QuestionBanksPage />} />
          <Route path="/question-banks/:id" element={<BankWorkspacePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  )
}
