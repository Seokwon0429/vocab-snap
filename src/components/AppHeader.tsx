import {
  BookOpen,
  Camera,
  GraduationCap,
  LoaderCircle,
  LogIn,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import type { AuthUser } from '../lib/auth'

export type AppTab = 'photo' | 'dictionary' | 'quiz' | 'admin'

interface AppHeaderProps {
  activeTab: AppTab
  wordCount: number
  onTabChange: (tab: AppTab) => void
  user: AuthUser | null
  authReady: boolean
  onOpenAuth: () => void
  onLogout: () => void
  onOpenSettings?: () => void
  offlineMode?: boolean
}

const navItems: Array<{ id: AppTab; label: string; icon: LucideIcon }> = [
  { id: 'photo', label: '사진·텍스트 추가', icon: Camera },
  { id: 'dictionary', label: '내 단어장', icon: BookOpen },
  { id: 'quiz', label: '퀴즈', icon: GraduationCap },
]

const adminNavItem = { id: 'admin' as const, label: '관리자', icon: ShieldCheck }

export function AppHeader({
  activeTab,
  wordCount,
  onTabChange,
  user,
  authReady,
  onOpenAuth,
  onLogout,
  onOpenSettings,
  offlineMode = false,
}: AppHeaderProps) {
  const canViewAdmin = !offlineMode && authReady && user?.role === 'admin'
  const baseNavItems = offlineMode
    ? navItems.filter((item) => item.id !== 'photo')
    : navItems
  const visibleNavItems = canViewAdmin
    ? [...baseNavItems, adminNavItem]
    : baseNavItems

  return (
    <header className="app-header">
      <div className="header-inner">
        <button
          type="button"
          className="brand"
          onClick={() => onTabChange(offlineMode ? 'dictionary' : 'photo')}
          aria-label="WordLens 홈으로 이동"
        >
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          <span className="brand-copy">
            <strong>WordLens</strong>
            <small>사진과 텍스트로 만드는 영어 습관</small>
          </span>
        </button>

        <div className="header-actions">
          <nav
            className={`main-nav ${canViewAdmin ? 'has-admin' : ''} ${offlineMode ? 'is-offline' : ''}`}
            aria-label="주요 메뉴"
          >
            {visibleNavItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`nav-button ${activeTab === id ? 'is-active' : ''}`}
                onClick={() => onTabChange(id)}
                aria-current={activeTab === id ? 'page' : undefined}
              >
                <Icon size={18} strokeWidth={2} aria-hidden="true" />
                <span>{label}</span>
                {id === 'dictionary' && wordCount > 0 ? (
                  <span className="nav-count" aria-label={`${wordCount}개`}>
                    {wordCount > 999 ? '999+' : wordCount}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="auth-controls">
            {onOpenSettings ? (
              <button
                type="button"
                className="auth-icon-button"
                onClick={onOpenSettings}
                aria-label="학습 설정 열기"
                title="학습 설정"
              >
                <Settings size={17} aria-hidden="true" />
              </button>
            ) : null}
            {!authReady ? (
              <span className="auth-loading" aria-label="로그인 상태 확인 중">
                <LoaderCircle size={17} className="spin-icon" aria-hidden="true" />
              </span>
            ) : user ? (
              <>
                <span className="account-chip" title={`${user.username} 계정으로 로그인됨`}>
                  <UserRound size={15} aria-hidden="true" />
                  <span>{user.username}</span>
                </span>
                <button type="button" className="auth-icon-button" onClick={onLogout} aria-label="로그아웃">
                  <LogOut size={17} aria-hidden="true" />
                </button>
              </>
            ) : (
              <button type="button" className="login-button" onClick={onOpenAuth}>
                <LogIn size={16} aria-hidden="true" />
                <span>로그인</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
