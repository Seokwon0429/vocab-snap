import { useCallback, useEffect, useRef, useState } from 'react'
import { AppHeader, type AppTab } from './components/AppHeader'
import { AdminView } from './components/AdminView'
import { DictionaryView } from './components/DictionaryView'
import { PhotoAddView } from './components/PhotoAddView'
import { QuizView } from './components/QuizView'
import { AuthDialog } from './components/AuthDialog'
import { Toast, type ToastKind, type ToastMessage } from './components/Toast'
import {
  getAll,
  getLocalVocabulary,
  importLocalVocabularyToServer,
  recordQuizResult,
} from './lib/storage'
import {
  getAuthSession,
  logoutAccount,
  restoreSession,
  subscribeAuth,
  type AuthSession,
} from './lib/auth'
import { useLocalSpeech } from './hooks/useLocalSpeech'
import type { QuizResult, WordEntry } from './types'

const tabTitles: Record<AppTab, string> = {
  photo: '사진으로 추가',
  dictionary: '내 단어장',
  quiz: '단어 퀴즈',
  admin: '관리자 통계',
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('photo')
  const [entries, setEntries] = useState<WordEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [storageError, setStorageError] = useState('')
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [session, setSession] = useState<AuthSession | null>(() => getAuthSession())
  const [authReady, setAuthReady] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [localWordCount, setLocalWordCount] = useState(0)
  const [localImportDismissed, setLocalImportDismissed] = useState(false)
  const [importingLocal, setImportingLocal] = useState(false)
  const [adminDeniedFor, setAdminDeniedFor] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const loadRequestRef = useRef(0)
  const {
    available: speechAvailable,
    loading: speechLoading,
    speak,
    stop: stopSpeech,
  } = useLocalSpeech()

  const notify = useCallback((text: string, kind: ToastKind = 'info') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    setToast({ id: Date.now(), kind, text })
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200)
  }, [])

  const storageScope = session ? `server:${session.user.id}` : 'local'
  const isAdmin = authReady
    && session?.user.role === 'admin'
    && adminDeniedFor !== session.user.id
  const visibleTab = activeTab === 'admin' && !isAdmin ? 'photo' : activeTab

  const loadEntries = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    try {
      const stored = await getAll()
      if (requestId !== loadRequestRef.current) return
      setEntries(stored)
      setStorageError('')
    } catch (error) {
      if (requestId !== loadRequestRef.current) return
      setStorageError(
        session
          ? error instanceof Error
            ? error.message
            : '개인 서버에 연결하지 못했어요. 서버 PC가 켜져 있는지 확인해 주세요.'
          : '브라우저 저장소를 열지 못했어요. 시크릿 모드를 종료하거나 저장 공간 설정을 확인해 주세요.',
      )
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }, [session])

  useEffect(() => {
    setEntries([])
    setLoading(true)
    setStorageError('')
    setLocalImportDismissed(false)
    void loadEntries()
  }, [loadEntries])

  useEffect(() => {
    const unsubscribe = subscribeAuth(setSession)
    void restoreSession()
      .catch((error) => {
        notify(
          error instanceof Error ? error.message : '로그인 상태를 확인하지 못했어요.',
          'error',
        )
      })
      .finally(() => setAuthReady(true))
    return unsubscribe
  }, [notify])

  useEffect(() => {
    if (!session) {
      setLocalWordCount(0)
      return
    }
    let cancelled = false
    void getLocalVocabulary()
      .then(({ entries: localEntries }) => {
        if (!cancelled) setLocalWordCount(localEntries.length)
      })
      .catch(() => {
        if (!cancelled) setLocalWordCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [session])

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
  }, [])

  useEffect(() => {
    document.title = `${tabTitles[visibleTab]} · WordLens`
    stopSpeech()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [stopSpeech, visibleTab])

  useEffect(() => {
    if (activeTab === 'admin' && !isAdmin) setActiveTab('photo')
  }, [activeTab, isAdmin])

  useEffect(() => {
    if (!session) setAdminDeniedFor(null)
  }, [session])

  const changeTab = (tab: AppTab) => {
    if (tab === 'admin' && !isAdmin) return
    setActiveTab(tab)
  }

  const closeAuth = useCallback(() => setAuthOpen(false), [])

  const speakWord = (word: string) => {
    if (!speak(word)) {
      notify(
        speechLoading
          ? '기기에 설치된 영어 음성을 찾고 있어요. 잠시 후 다시 눌러 주세요.'
          : '개인정보 보호를 위해 기기에 설치된 영어 음성만 사용해요. 사용할 수 있는 로컬 영어 음성이 없습니다.',
        'info',
      )
    }
  }

  const handleWordsAdded = async (count: number) => {
    await loadEntries()
    notify(`${count}개 단어를 내 단어장에 추가했어요.`, 'success')
    setActiveTab('dictionary')
  }

  const handleQuizRate = async (entry: WordEntry, result: QuizResult) => {
    const updated = await recordQuizResult(entry.id, result)
    setEntries((current) =>
      current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
    )
  }

  const handleAuthenticated = (nextSession: AuthSession, mode: 'login' | 'register') => {
    setSession(nextSession)
    notify(
      mode === 'register'
        ? `${nextSession.user.username} 계정을 만들고 로그인했어요.`
        : `${nextSession.user.username}(으)로 로그인했어요.`,
      'success',
    )
  }

  const handleLogout = async () => {
    const username = session?.user.username
    try {
      await logoutAccount()
      notify(`${username ?? '계정'}에서 로그아웃했어요.`, 'success')
    } catch {
      notify('서버 연결은 끊겼지만 이 브라우저에서는 로그아웃했어요.', 'info')
    }
  }

  const handleAdminForbidden = useCallback(() => {
    if (session) setAdminDeniedFor(session.user.id)
    setActiveTab('photo')
    notify('관리자 권한이 없습니다.', 'error')
  }, [notify, session])

  const importLocalWords = async () => {
    if (!window.confirm(
      `이 브라우저에 저장된 ${localWordCount}개 단어와 폴더를 ${session?.user.username} 계정에 합칠까요? 로컬 원본은 삭제하지 않습니다.`,
    )) return

    setImportingLocal(true)
    try {
      const result = await importLocalVocabularyToServer()
      await loadEntries()
      setLocalImportDismissed(true)
      notify(
        `${result.added.length}개 단어를 서버 단어장으로 가져왔어요.${result.duplicates.length ? ` 중복 ${result.duplicates.length}개는 건너뛰었어요.` : ''}`,
        'success',
      )
    } catch (error) {
      notify(error instanceof Error ? error.message : '로컬 단어를 가져오지 못했어요.', 'error')
    } finally {
      setImportingLocal(false)
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">본문으로 바로가기</a>
      <AppHeader
        activeTab={visibleTab}
        wordCount={entries.length}
        onTabChange={changeTab}
        user={session?.user ?? null}
        authReady={authReady}
        onOpenAuth={() => setAuthOpen(true)}
        onLogout={() => void handleLogout()}
      />

      {session && localWordCount > 0 && !localImportDismissed ? (
        <div className="sync-banner" role="status">
          <div>
            <strong>이 브라우저에 로컬 단어 {localWordCount}개가 남아 있어요.</strong>
            <span>원하면 현재 로그인한 서버 단어장에 안전하게 합칠 수 있습니다.</span>
          </div>
          <div className="sync-banner-actions">
            <button type="button" className="text-button" onClick={() => setLocalImportDismissed(true)}>
              닫기
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={importingLocal}
              onClick={() => void importLocalWords()}
            >
              {importingLocal ? '가져오는 중…' : '서버로 가져오기'}
            </button>
          </div>
        </div>
      ) : null}

      {storageError ? (
        <div className="global-error" role="alert">
          <span aria-hidden="true">!</span>
          <p>{storageError}</p>
          <button type="button" className="text-button" onClick={() => void loadEntries()}>다시 시도</button>
        </div>
      ) : null}

      <main id="main-content" tabIndex={-1}>
        {visibleTab === 'photo' ? (
          <PhotoAddView key={storageScope} entries={entries} onWordsAdded={handleWordsAdded} notify={notify} />
        ) : null}
        {visibleTab === 'dictionary' ? (
          <DictionaryView
            key={storageScope}
            entries={entries}
            loading={loading}
            speechAvailable={speechAvailable}
            onSpeak={speakWord}
            onChanged={loadEntries}
            notify={notify}
          />
        ) : null}
        {visibleTab === 'quiz' ? (
          <QuizView
            key={storageScope}
            entries={entries}
            onRate={handleQuizRate}
            onSpeak={speakWord}
            speechAvailable={speechAvailable}
          />
        ) : null}
        {visibleTab === 'admin' && isAdmin && session ? (
          <AdminView
            key={storageScope}
            accountId={session.user.id}
            onForbidden={handleAdminForbidden}
          />
        ) : null}
      </main>

      <footer className="app-footer">
        <div>
          <span className="footer-brand">WordLens</span>
          <p>
            {session
              ? '사진 OCR은 브라우저에서 처리하고, 단어는 로그인한 개인 서버에 저장됩니다.'
              : '사진과 단어는 이 브라우저 안에서만 처리·저장됩니다.'}
          </p>
        </div>
        <p>{session ? `${session.user.username}의 서버 단어장` : '게스트 로컬 단어장'}</p>
      </footer>

      <AuthDialog
        open={authOpen}
        onClose={closeAuth}
        onAuthenticated={handleAuthenticated}
      />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
