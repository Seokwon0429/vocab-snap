import { useEffect, useRef, useState } from 'react'
import { KeyRound, LogIn, UserPlus, X } from 'lucide-react'
import {
  isServerConfigured,
  loginAccount,
  registerAccount,
  type AuthSession,
} from '../lib/auth'

interface AuthDialogProps {
  open: boolean
  onClose: () => void
  onAuthenticated: (session: AuthSession, mode: 'login' | 'register') => void
}

export function AuthDialog({ open, onClose, onAuthenticated }: AuthDialogProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setError('')
    window.setTimeout(() => usernameRef.current?.focus(), 0)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, open])

  if (!open) return null

  const changeMode = (nextMode: 'login' | 'register') => {
    setMode(nextMode)
    setError('')
    setPassword('')
    setPasswordConfirm('')
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isServerConfigured()) {
      setError('서버 주소가 아직 설정되지 않았습니다.')
      return
    }
    if (mode === 'register' && password !== passwordConfirm) {
      setError('비밀번호 확인이 일치하지 않습니다.')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const session = mode === 'register'
        ? await registerAccount({ username, password, inviteCode: inviteCode || undefined })
        : await loginAccount({ username, password })
      onAuthenticated(session, mode)
      setPassword('')
      setPasswordConfirm('')
      onClose()
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : '로그인 요청에 실패했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !submitting) onClose()
    }}>
      <section
        className="modal auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
      >
        <div className="modal-header auth-modal-header">
          <div>
            <span className="eyebrow"><KeyRound size={13} /> ACCOUNT</span>
            <h2 id="auth-title">{mode === 'login' ? '내 단어장 로그인' : '새 계정 만들기'}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={submitting}
            aria-label="계정 창 닫기"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>

        <div className="auth-mode-tabs" role="tablist" aria-label="계정 작업 선택">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'is-active' : ''}
            onClick={() => changeMode('login')}
          >로그인</button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'is-active' : ''}
            onClick={() => changeMode('register')}
          >회원가입</button>
        </div>

        <form onSubmit={(event) => void submit(event)}>
          <div className="auth-form-grid">
            <label className="field-label">
              <span>아이디</span>
              <input
                ref={usernameRef}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                minLength={3}
                maxLength={32}
                required
              />
              <small className="field-help">3~32자 · 한글, 영문, 숫자, 점, 밑줄, 하이픈</small>
            </label>
            <label className="field-label">
              <span>비밀번호</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={8}
                maxLength={128}
                required
              />
              <small className="field-help">8자 이상 입력해 주세요.</small>
            </label>
            {mode === 'register' ? (
              <>
                <label className="field-label">
                  <span>비밀번호 확인</span>
                  <input
                    type="password"
                    value={passwordConfirm}
                    onChange={(event) => setPasswordConfirm(event.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={128}
                    required
                  />
                </label>
                <label className="field-label">
                  <span>초대 코드 <em>설정된 서버만</em></span>
                  <input
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                    autoComplete="off"
                    maxLength={128}
                  />
                </label>
              </>
            ) : null}
          </div>

          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <p className="auth-privacy-note">
            로그인하면 단어와 폴더가 이 기기가 아닌 개인 서버의 사용자별 공간에 저장됩니다.
          </p>
          <div className="modal-actions auth-modal-actions">
            <button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}>
              취소
            </button>
            <button type="submit" className="button button-primary" disabled={submitting}>
              {submitting ? <span className="spinner small" aria-hidden="true" /> : mode === 'login'
                ? <LogIn size={17} aria-hidden="true" />
                : <UserPlus size={17} aria-hidden="true" />}
              {submitting ? '처리하는 중…' : mode === 'login' ? '로그인' : '회원가입'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
