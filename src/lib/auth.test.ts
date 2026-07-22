import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storedSession = {
  token: 'test-session-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: {
    id: 'user-1',
    username: 'tester',
    createdAt: '2026-07-22T00:00:00.000Z',
  },
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('서버 인증 클라이언트', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('회원가입 세션을 브라우저에 보관한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(storedSession, 201))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await import('./auth')

    await expect(auth.registerAccount({
      username: 'tester',
      password: 'password-123',
    })).resolves.toMatchObject({ token: 'test-session-token' })
    expect(auth.getAuthSession()?.user.username).toBe('tester')
    expect(sessionStorage.getItem('wordlens-auth-session-v1')).toContain('test-session-token')
    expect(localStorage.getItem('wordlens-auth-session-v1')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/auth/register',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('서버가 토큰을 거부하면 저장된 세션을 제거한다', async () => {
    sessionStorage.setItem('wordlens-auth-session-v1', JSON.stringify(storedSession))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: { code: 'UNAUTHORIZED', message: '로그인이 만료되었습니다.' },
    }, 401)))
    const auth = await import('./auth')

    await expect(auth.restoreSession()).resolves.toBeNull()
    expect(auth.getAuthSession()).toBeNull()
    expect(sessionStorage.getItem('wordlens-auth-session-v1')).toBeNull()
  })

  it('서버가 꺼진 경우 세션을 지우거나 로컬 모드로 바꾸지 않는다', async () => {
    sessionStorage.setItem('wordlens-auth-session-v1', JSON.stringify(storedSession))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')))
    const auth = await import('./auth')

    await expect(auth.restoreSession()).rejects.toMatchObject({
      code: 'SERVER_UNREACHABLE',
    })
    expect(auth.getAuthSession()?.token).toBe('test-session-token')
  })
})
