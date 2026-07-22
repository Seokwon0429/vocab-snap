export interface AuthUser {
  id: string
  username: string
  createdAt: string
  role: 'user' | 'admin'
}

export interface AuthSession {
  token: string
  expiresAt: string
  user: AuthUser
}

interface ApiErrorPayload {
  error?: {
    code?: string
    message?: string
  }
}

const SESSION_KEY = 'wordlens-auth-session-v1'
const API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL)
const listeners = new Set<(session: AuthSession | null) => void>()

export class ApiClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
  }
}

function normalizeApiUrl(value: string | undefined): string {
  const raw = value?.trim()
  if (raw) return raw.replace(/\/$/, '')
  return import.meta.env.DEV ? 'http://127.0.0.1:8787/api' : ''
}

function readStoredSession(): AuthSession | null {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    // 이전 버전의 토큰 저장소가 차단된 경우에도 탭 세션 복구를 계속합니다.
  }
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<AuthSession>
    if (
      typeof value.token !== 'string'
      || typeof value.expiresAt !== 'string'
      || !value.user
      || typeof value.user.id !== 'string'
      || typeof value.user.username !== 'string'
      || Number.isNaN(Date.parse(value.expiresAt))
    ) {
      sessionStorage.removeItem(SESSION_KEY)
      return null
    }
    if (Date.parse(value.expiresAt) <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY)
      return null
    }
    return {
      ...value,
      user: {
        ...value.user,
        // Web Storage can be edited by the browser user. Only /auth/me may
        // restore an administrator role after a reload.
        role: 'user',
      },
    } as AuthSession
  } catch {
    try {
      sessionStorage.removeItem(SESSION_KEY)
    } catch {
      // 저장소가 차단돼도 현재 탭의 메모리 세션은 사용할 수 있습니다.
    }
    return null
  }
}

let currentSession = readStoredSession()

function updateSession(session: AuthSession | null) {
  currentSession = session
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    // 이전 버전의 영구 토큰을 지울 수 없어도 현재 세션 갱신을 계속합니다.
  }
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // 저장소를 사용할 수 없는 브라우저에서는 새로고침 전까지만 로그인합니다.
  }
  listeners.forEach((listener) => listener(session))
}

export function getAuthSession(): AuthSession | null {
  return currentSession
}

export function isServerConfigured(): boolean {
  return Boolean(API_URL)
}

export function subscribeAuth(listener: (session: AuthSession | null) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { authenticated?: boolean } = {},
): Promise<T> {
  if (!API_URL) {
    throw new ApiClientError(
      0,
      'SERVER_NOT_CONFIGURED',
      '서버 주소가 설정되지 않았습니다. VITE_API_URL을 설정해 주세요.',
    )
  }

  const { authenticated = true, headers, ...requestOptions } = options
  const requestHeaders = new Headers(headers)
  if (requestOptions.body && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json')
  }
  if (authenticated) {
    if (!currentSession?.token) {
      throw new ApiClientError(401, 'UNAUTHORIZED', '로그인이 필요합니다.')
    }
    requestHeaders.set('Authorization', `Bearer ${currentSession.token}`)
  }

  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...requestOptions,
      headers: requestHeaders,
    })
  } catch {
    throw new ApiClientError(
      0,
      'SERVER_UNREACHABLE',
      '개인 서버에 연결할 수 없습니다. 서버 PC가 켜져 있는지 확인해 주세요.',
    )
  }

  const payload = await response.json().catch(() => ({})) as ApiErrorPayload & T
  if (!response.ok) {
    const error = new ApiClientError(
      response.status,
      payload.error?.code ?? 'REQUEST_FAILED',
      payload.error?.message ?? '서버 요청에 실패했습니다.',
    )
    if (authenticated && response.status === 401) updateSession(null)
    throw error
  }
  return payload
}

export async function restoreSession(): Promise<AuthSession | null> {
  if (!currentSession) return null
  try {
    const payload = await apiRequest<{ user: AuthUser }>('/auth/me')
    const session = { ...currentSession, user: payload.user }
    updateSession(session)
    return session
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) return null
    throw error
  }
}

export async function registerAccount(input: {
  username: string
  password: string
  inviteCode?: string
}): Promise<AuthSession> {
  const session = await apiRequest<AuthSession>('/auth/register', {
    authenticated: false,
    method: 'POST',
    body: JSON.stringify(input),
  })
  updateSession(session)
  return session
}

export async function loginAccount(input: {
  username: string
  password: string
}): Promise<AuthSession> {
  const session = await apiRequest<AuthSession>('/auth/login', {
    authenticated: false,
    method: 'POST',
    body: JSON.stringify(input),
  })
  updateSession(session)
  return session
}

export async function logoutAccount(): Promise<void> {
  const token = currentSession?.token
  updateSession(null)
  if (!token) return

  await apiRequest<{ ok: boolean }>('/auth/logout', {
    authenticated: false,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}
