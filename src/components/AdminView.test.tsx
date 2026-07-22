import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAdminStats, type AdminStats } from '../lib/admin'
import { ApiClientError } from '../lib/auth'
import { AdminView } from './AdminView'

vi.mock('../lib/admin', () => ({
  getAdminStats: vi.fn(),
}))

const getAdminStatsMock = vi.mocked(getAdminStats)

const stats: AdminStats = {
  summary: {
    totalUserCount: 2,
    totalFolderCount: 7,
    totalWordCount: 321,
  },
  users: [
    {
      userId: 'user-123456789',
      username: 'learner',
      createdAt: '2026-07-20T03:30:00.000Z',
      folderCount: 4,
      wordCount: 200,
    },
    {
      userId: 'user-987654321',
      username: 'reader',
      createdAt: '2026-07-21T05:00:00.000Z',
      folderCount: 3,
      wordCount: 121,
    },
  ],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('관리자 통계 화면', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('전체 수치와 사용자별 공개 통계만 표시한다', async () => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')
    getAdminStatsMock.mockResolvedValue(stats)

    render(<AdminView accountId="admin-1" onForbidden={vi.fn()} />)

    const memberCard = (await screen.findByText('전체 회원')).closest('article')
    expect(memberCard).not.toBeNull()
    expect(within(memberCard!).getByText('2')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '사용자 ID' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '아이디' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '가입일' })).toBeInTheDocument()
    expect(screen.getByText('user-123456789')).toBeInTheDocument()
    expect(screen.getByText('learner')).toBeInTheDocument()
    expect(screen.queryByText(/password|token|비밀번호|토큰/i)).not.toBeInTheDocument()
    expect(storageWrite).not.toHaveBeenCalled()
    storageWrite.mockRestore()
  })

  it('403이면 통계를 비우고 관리자 화면 닫기를 요청한다', async () => {
    const onForbidden = vi.fn()
    getAdminStatsMock.mockRejectedValue(
      new ApiClientError(403, 'FORBIDDEN', '접근할 수 없습니다.'),
    )

    render(<AdminView accountId="admin-1" onForbidden={onForbidden} />)

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('네트워크 오류를 표시하고 같은 화면에서 다시 시도한다', async () => {
    getAdminStatsMock
      .mockRejectedValueOnce(
        new ApiClientError(0, 'SERVER_UNREACHABLE', '개인 서버에 연결할 수 없습니다.'),
      )
      .mockResolvedValueOnce(stats)

    render(<AdminView accountId="admin-1" onForbidden={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('개인 서버에 연결할 수 없습니다.')
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByText('learner')).toBeInTheDocument()
    expect(getAdminStatsMock).toHaveBeenCalledTimes(2)
  })

  it('계정 전환 뒤에는 이전 계정의 느린 응답을 무시한다', async () => {
    const first = deferred<AdminStats>()
    const second = deferred<AdminStats>()
    const onForbidden = vi.fn()
    getAdminStatsMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const { rerender } = render(
      <AdminView accountId="admin-a" onForbidden={onForbidden} />,
    )
    rerender(<AdminView accountId="admin-b" onForbidden={onForbidden} />)

    await act(async () => {
      first.resolve({
        summary: { totalUserCount: 1, totalFolderCount: 1, totalWordCount: 1 },
        users: [{
          userId: 'old-user',
          username: 'old-account-data',
          createdAt: '2026-07-01T00:00:00.000Z',
          folderCount: 1,
          wordCount: 1,
        }],
      })
      await first.promise
    })
    expect(screen.queryByText('old-account-data')).not.toBeInTheDocument()

    await act(async () => {
      second.resolve(stats)
      await second.promise
    })
    expect(await screen.findByText('learner')).toBeInTheDocument()
  })
})
