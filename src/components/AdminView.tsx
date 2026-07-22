import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  UsersRound,
} from 'lucide-react'
import { getAdminStats, type AdminStats } from '../lib/admin'
import { ApiClientError } from '../lib/auth'

interface AdminViewProps {
  accountId: string
  onForbidden: () => void
}

function formatCount(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value)
}

function formatJoinedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '알 수 없음'
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function adminErrorMessage(error: unknown) {
  if (error instanceof ApiClientError && error.status === 403) {
    return '관리자 권한이 없습니다.'
  }
  return error instanceof Error
    ? error.message
    : '관리자 통계를 불러오지 못했습니다.'
}

export function AdminView({ accountId, onForbidden }: AdminViewProps) {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loadedAccountId, setLoadedAccountId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const loadStats = useCallback(async () => {
    const requestId = ++requestRef.current
    setStats(null)
    setLoadedAccountId(null)
    setError('')
    setLoading(true)

    try {
      const nextStats = await getAdminStats()
      if (requestId === requestRef.current) {
        setStats(nextStats)
        setLoadedAccountId(accountId)
      }
    } catch (loadError) {
      if (requestId !== requestRef.current) return
      if (loadError instanceof ApiClientError && loadError.status === 403) {
        setStats(null)
        setLoadedAccountId(null)
        onForbidden()
        return
      }
      setError(adminErrorMessage(loadError))
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [accountId, onForbidden])

  const visibleStats = loadedAccountId === accountId ? stats : null

  useEffect(() => {
    void loadStats()
    return () => {
      requestRef.current += 1
    }
  }, [loadStats])

  return (
    <section className="page admin-page" aria-labelledby="admin-title">
      <div className="page-heading admin-heading">
        <div>
          <span className="eyebrow">ADMINISTRATION</span>
          <h1 id="admin-title">관리자 통계</h1>
          <p>회원별 단어장 사용 현황을 확인할 수 있습니다.</p>
        </div>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => void loadStats()}
          disabled={loading}
        >
          <RefreshCw size={17} className={loading ? 'spin-icon' : undefined} aria-hidden="true" />
          새로고침
        </button>
      </div>

      {loading ? (
        <div className="admin-state surface" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <p>관리자 통계를 불러오는 중입니다.</p>
        </div>
      ) : error ? (
        <div className="admin-state admin-state-error surface" role="alert">
          <ShieldCheck size={27} aria-hidden="true" />
          <p>{error}</p>
          <button type="button" className="button button-secondary compact-button" onClick={() => void loadStats()}>
            다시 시도
          </button>
        </div>
      ) : visibleStats ? (
        <>
          <div className="admin-summary-grid" aria-label="전체 사용 현황">
            <article className="admin-summary-card surface">
              <UsersRound size={22} aria-hidden="true" />
              <span>전체 회원</span>
              <strong>{formatCount(visibleStats.summary.totalUserCount)}</strong>
            </article>
            <article className="admin-summary-card surface">
              <FolderOpen size={22} aria-hidden="true" />
              <span>전체 폴더</span>
              <strong>{formatCount(visibleStats.summary.totalFolderCount)}</strong>
            </article>
            <article className="admin-summary-card surface">
              <BookOpen size={22} aria-hidden="true" />
              <span>전체 단어</span>
              <strong>{formatCount(visibleStats.summary.totalWordCount)}</strong>
            </article>
          </div>

          <div className="admin-users-panel surface">
            <div className="admin-users-heading">
              <div>
                <span className="eyebrow">USERS</span>
                <h2>사용자별 현황</h2>
              </div>
              <span>{formatCount(visibleStats.users.length)}명</span>
            </div>
            <div className="admin-table-scroll">
              <table className="admin-table">
                <caption className="sr-only">사용자별 아이디, 가입일, 폴더 수와 단어 수</caption>
                <thead>
                  <tr>
                    <th scope="col">사용자 ID</th>
                    <th scope="col">아이디</th>
                    <th scope="col">가입일</th>
                    <th scope="col">폴더</th>
                    <th scope="col">단어</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleStats.users.length > 0 ? visibleStats.users.map((user) => (
                    <tr key={user.userId}>
                      <td className="admin-user-id">{user.userId}</td>
                      <td className="admin-username">{user.username}</td>
                      <td>{formatJoinedAt(user.createdAt)}</td>
                      <td>{formatCount(user.folderCount)}</td>
                      <td>{formatCount(user.wordCount)}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td className="admin-empty-row" colSpan={5}>표시할 사용자가 없습니다.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </section>
  )
}
