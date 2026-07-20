import { BookOpen, Camera, GraduationCap } from 'lucide-react'

export type AppTab = 'photo' | 'dictionary' | 'quiz'

interface AppHeaderProps {
  activeTab: AppTab
  wordCount: number
  onTabChange: (tab: AppTab) => void
}

const navItems = [
  { id: 'photo' as const, label: '사진으로 추가', icon: Camera },
  { id: 'dictionary' as const, label: '내 단어장', icon: BookOpen },
  { id: 'quiz' as const, label: '퀴즈', icon: GraduationCap },
]

export function AppHeader({ activeTab, wordCount, onTabChange }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="header-inner">
        <button
          type="button"
          className="brand"
          onClick={() => onTabChange('photo')}
          aria-label="WordLens 홈으로 이동"
        >
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          <span className="brand-copy">
            <strong>WordLens</strong>
            <small>사진에서 시작하는 영어 습관</small>
          </span>
        </button>

        <nav className="main-nav" aria-label="주요 메뉴">
          {navItems.map(({ id, label, icon: Icon }) => (
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
      </div>
    </header>
  )
}
