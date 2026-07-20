import { useCallback, useEffect, useRef, useState } from 'react'
import { AppHeader, type AppTab } from './components/AppHeader'
import { DictionaryView } from './components/DictionaryView'
import { PhotoAddView } from './components/PhotoAddView'
import { QuizView } from './components/QuizView'
import { Toast, type ToastKind, type ToastMessage } from './components/Toast'
import { getAll, recordQuizResult } from './lib/db'
import { useLocalSpeech } from './hooks/useLocalSpeech'
import type { QuizResult, WordEntry } from './types'

const tabTitles: Record<AppTab, string> = {
  photo: '사진으로 추가',
  dictionary: '내 단어장',
  quiz: '단어 퀴즈',
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('photo')
  const [entries, setEntries] = useState<WordEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [storageError, setStorageError] = useState('')
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const toastTimerRef = useRef<number | null>(null)
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

  const loadEntries = useCallback(async () => {
    try {
      const stored = await getAll()
      setEntries(stored)
      setStorageError('')
    } catch {
      setStorageError(
        '브라우저 저장소를 열지 못했어요. 시크릿 모드를 종료하거나 저장 공간 설정을 확인해 주세요.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadEntries()
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    }
  }, [loadEntries])

  useEffect(() => {
    document.title = `${tabTitles[activeTab]} · WordLens`
    stopSpeech()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [activeTab, stopSpeech])

  const changeTab = (tab: AppTab) => {
    setActiveTab(tab)
  }

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

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">본문으로 바로가기</a>
      <AppHeader activeTab={activeTab} wordCount={entries.length} onTabChange={changeTab} />

      {storageError ? (
        <div className="global-error" role="alert">
          <span aria-hidden="true">!</span>
          <p>{storageError}</p>
          <button type="button" className="text-button" onClick={() => void loadEntries()}>다시 시도</button>
        </div>
      ) : null}

      <main id="main-content" tabIndex={-1}>
        {activeTab === 'photo' ? (
          <PhotoAddView entries={entries} onWordsAdded={handleWordsAdded} notify={notify} />
        ) : null}
        {activeTab === 'dictionary' ? (
          <DictionaryView
            entries={entries}
            loading={loading}
            speechAvailable={speechAvailable}
            onSpeak={speakWord}
            onChanged={loadEntries}
            notify={notify}
          />
        ) : null}
        {activeTab === 'quiz' ? (
          <QuizView
            entries={entries}
            onRate={handleQuizRate}
            onSpeak={speakWord}
            speechAvailable={speechAvailable}
          />
        ) : null}
      </main>

      <footer className="app-footer">
        <div>
          <span className="footer-brand">WordLens</span>
          <p>사진과 단어는 브라우저 안에서만 처리·저장됩니다.</p>
        </div>
        <p>서버 · 광고 · API 키 없이 무료로</p>
      </footer>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
