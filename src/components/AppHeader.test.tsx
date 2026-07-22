import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AuthUser } from '../lib/auth'
import { AppHeader, type AppTab } from './AppHeader'

const regularUser: AuthUser = {
  id: 'user-1',
  username: 'learner',
  createdAt: '2026-07-22T00:00:00.000Z',
  role: 'user',
}

const adminUser: AuthUser = {
  ...regularUser,
  id: 'admin-1',
  username: 'operator',
  role: 'admin',
}

function renderHeader({
  user = regularUser,
  authReady = true,
  onTabChange = vi.fn(),
}: {
  user?: AuthUser | null
  authReady?: boolean
  onTabChange?: (tab: AppTab) => void
} = {}) {
  return render(
    <AppHeader
      activeTab="photo"
      wordCount={0}
      onTabChange={onTabChange}
      user={user}
      authReady={authReady}
      onOpenAuth={vi.fn()}
      onLogout={vi.fn()}
    />,
  )
}

describe('앱 헤더 관리자 메뉴', () => {
  it('일반 사용자 DOM에는 관리자 버튼을 만들지 않는다', () => {
    renderHeader()

    expect(screen.queryByRole('button', { name: '관리자' })).not.toBeInTheDocument()
  })

  it('저장된 관리자 역할만 있고 서버 인증 확인 전이면 버튼을 숨긴다', () => {
    renderHeader({ user: adminUser, authReady: false })

    expect(screen.queryByRole('button', { name: '관리자' })).not.toBeInTheDocument()
  })

  it('서버에서 확인된 관리자만 관리자 화면을 열 수 있다', async () => {
    const onTabChange = vi.fn()
    renderHeader({ user: adminUser, onTabChange })

    await userEvent.click(screen.getByRole('button', { name: '관리자' }))
    expect(onTabChange).toHaveBeenCalledWith('admin')
  })
})
