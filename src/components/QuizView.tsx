import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  BarChart3,
  Check,
  Eye,
  FolderOpen,
  Keyboard,
  Play,
  RefreshCw,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react'

import { getFolders } from '../lib/storage'
import type { QuizResult, VocabularyFolder, WordEntry } from '../types'

interface QuizViewProps {
  entries: WordEntry[]
  onRate: (entry: WordEntry, result: QuizResult) => Promise<void>
  onSpeak: (word: string) => void
  speechAvailable: boolean
}

interface SessionStats {
  known: number
  unknown: number
}

type QuizFolderFilter = 'all' | 'unfiled' | string

const EMPTY_SESSION: SessionStats = { known: 0, unknown: 0 }
const quizEntryCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
})

function sortQuizEntries(entries: WordEntry[]): WordEntry[] {
  return [...entries].sort(
    (left, right) =>
      quizEntryCollator.compare(left.word, right.word) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  )
}

function shuffleEntries(entries: WordEntry[]): WordEntry[] {
  const shuffled = [...entries]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[index],
    ]
  }

  return shuffled
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  return (
    target.isContentEditable ||
    target.matches(
      'input, textarea, select, button, a, [role="button"], [role="textbox"]',
    )
  )
}

export function QuizView({
  entries,
  onRate,
  onSpeak,
  speechAvailable,
}: QuizViewProps) {
  const eligibleEntries = useMemo(
    () => entries.filter((entry) => entry.meaning.trim().length > 0),
    [entries],
  )
  const eligibleSignature = useMemo(
    () =>
      eligibleEntries
        .map((entry) => `${entry.id}:${entry.folderId ?? ''}`)
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    [eligibleEntries],
  )

  const [folders, setFolders] = useState<VocabularyFolder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [folderError, setFolderError] = useState('')
  const [selectedFolderId, setSelectedFolderId] =
    useState<QuizFolderFilter>('all')
  const [rangeStart, setRangeStart] = useState('1')
  const [rangeEnd, setRangeEnd] = useState('')
  const [setupError, setSetupError] = useState('')
  const [quizStarted, setQuizStarted] = useState(false)
  const [queue, setQueue] = useState<WordEntry[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isRevealed, setIsRevealed] = useState(false)
  const [isRating, setIsRating] = useState(false)
  const [ratingError, setRatingError] = useState<string | null>(null)
  const [sessionStats, setSessionStats] =
    useState<SessionStats>(EMPTY_SESSION)
  const previousSignatureRef = useRef(eligibleSignature)
  const ratingLockRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setFoldersLoading(true)
    setFolderError('')

    void getFolders()
      .then((storedFolders) => {
        if (!cancelled) setFolders(storedFolders)
      })
      .catch(() => {
        if (!cancelled) setFolderError('폴더 목록을 불러오지 못했어요.')
      })
      .finally(() => {
        if (!cancelled) setFoldersLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const validFolderIds = useMemo(
    () => new Set(folders.map((folder) => folder.id)),
    [folders],
  )
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const folder of folders) counts.set(folder.id, 0)
    for (const entry of eligibleEntries) {
      if (entry.folderId && validFolderIds.has(entry.folderId)) {
        counts.set(entry.folderId, (counts.get(entry.folderId) ?? 0) + 1)
      }
    }
    return counts
  }, [eligibleEntries, folders, validFolderIds])
  const unfiledCount = useMemo(
    () =>
      eligibleEntries.filter(
        (entry) => !entry.folderId || !validFolderIds.has(entry.folderId),
      ).length,
    [eligibleEntries, validFolderIds],
  )
  const scopedEntries = useMemo(() => {
    const filtered = eligibleEntries.filter((entry) => {
      if (selectedFolderId === 'all') return true
      if (selectedFolderId === 'unfiled') {
        return !entry.folderId || !validFolderIds.has(entry.folderId)
      }
      return entry.folderId === selectedFolderId
    })
    return sortQuizEntries(filtered)
  }, [eligibleEntries, selectedFolderId, validFolderIds])
  const scopedSignature = useMemo(
    () => scopedEntries.map((entry) => entry.id).join('|'),
    [scopedEntries],
  )
  const selectedFolderLabel = useMemo(() => {
    if (selectedFolderId === 'all') return '전체 단어'
    if (selectedFolderId === 'unfiled') return '미분류'
    return (
      folders.find((folder) => folder.id === selectedFolderId)?.name ??
      '전체 단어'
    )
  }, [folders, selectedFolderId])

  useEffect(() => {
    if (
      selectedFolderId !== 'all' &&
      selectedFolderId !== 'unfiled' &&
      !validFolderIds.has(selectedFolderId)
    ) {
      setSelectedFolderId('all')
    }
  }, [selectedFolderId, validFolderIds])

  useEffect(() => {
    setRangeStart(scopedEntries.length ? '1' : '')
    setRangeEnd(scopedEntries.length ? String(scopedEntries.length) : '')
    setSetupError('')
    setQuizStarted(false)
    setQueue([])
    setCurrentIndex(0)
    setIsRevealed(false)
    setSessionStats(EMPTY_SESSION)
  }, [scopedEntries.length, scopedSignature, selectedFolderId])

  useEffect(() => {
    if (previousSignatureRef.current === eligibleSignature) return

    previousSignatureRef.current = eligibleSignature
    ratingLockRef.current = false
    setQuizStarted(false)
    setQueue([])
    setCurrentIndex(0)
    setIsRevealed(false)
    setIsRating(false)
    setRatingError(null)
    setSessionStats(EMPTY_SESSION)
  }, [eligibleSignature])

  const accumulatedStats = useMemo(() => {
    return entries.reduce(
      (stats, entry) => {
        const quizStats = entry.quizStats
        const attempts = quizStats?.attempts ?? 0

        stats.attempts += attempts
        stats.known += quizStats?.knownCount ?? 0
        stats.unknown += quizStats?.unknownCount ?? 0
        if (attempts > 0) stats.studied += 1

        return stats
      },
      { attempts: 0, known: 0, unknown: 0, studied: 0 },
    )
  }, [entries])

  const currentEntry = queue[currentIndex]
  const isFinished = quizStarted && queue.length > 0 && currentIndex >= queue.length
  const sessionTotal = sessionStats.known + sessionStats.unknown
  const sessionAccuracy = sessionTotal
    ? Math.round((sessionStats.known / sessionTotal) * 100)
    : 0
  const accumulatedAccuracy = accumulatedStats.attempts
    ? Math.round((accumulatedStats.known / accumulatedStats.attempts) * 100)
    : 0

  const revealAnswer = useCallback(() => {
    if (!currentEntry || isRevealed || isRating) return
    setRatingError(null)
    setIsRevealed(true)
  }, [currentEntry, isRating, isRevealed])

  const rateCurrentEntry = useCallback(
    async (result: QuizResult) => {
      if (
        !currentEntry ||
        !isRevealed ||
        isRating ||
        ratingLockRef.current
      ) {
        return
      }

      ratingLockRef.current = true
      setIsRating(true)
      setRatingError(null)

      try {
        await onRate(currentEntry, result)
        setSessionStats((current) => ({
          ...current,
          [result]: current[result] + 1,
        }))
        setCurrentIndex((index) => index + 1)
        setIsRevealed(false)
      } catch {
        setRatingError(
          '학습 결과를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
        )
      } finally {
        ratingLockRef.current = false
        setIsRating(false)
      }
    },
    [currentEntry, isRating, isRevealed, onRate],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTypingTarget(event.target)
      ) {
        return
      }

      if (event.code === 'Space' && currentEntry && !isRevealed) {
        event.preventDefault()
        revealAnswer()
        return
      }

      if (!isRevealed) return

      if (event.key === '1') {
        event.preventDefault()
        void rateCurrentEntry('unknown')
      } else if (event.key === '2') {
        event.preventDefault()
        void rateCurrentEntry('known')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentEntry, isRevealed, rateCurrentEntry, revealAnswer])

  const startQuiz = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const start = Number(rangeStart)
    const end = Number(rangeEnd)

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > scopedEntries.length
    ) {
      setSetupError(
        scopedEntries.length
          ? `1번부터 ${scopedEntries.length}번 사이에서 올바른 범위를 선택해 주세요.`
          : '선택한 폴더에 퀴즈를 시작할 단어가 없어요.',
      )
      return
    }

    ratingLockRef.current = false
    setQueue(shuffleEntries(scopedEntries.slice(start - 1, end)))
    setCurrentIndex(0)
    setIsRevealed(false)
    setIsRating(false)
    setRatingError(null)
    setSessionStats(EMPTY_SESSION)
    setSetupError('')
    setQuizStarted(true)
  }

  const restartQuiz = () => {
    ratingLockRef.current = false
    setQueue((current) => shuffleEntries(current))
    setCurrentIndex(0)
    setIsRevealed(false)
    setIsRating(false)
    setRatingError(null)
    setSessionStats(EMPTY_SESSION)
  }

  const returnToSetup = () => {
    ratingLockRef.current = false
    setQuizStarted(false)
    setQueue([])
    setCurrentIndex(0)
    setIsRevealed(false)
    setIsRating(false)
    setRatingError(null)
    setSessionStats(EMPTY_SESSION)
  }

  if (eligibleEntries.length === 0) {
    return (
      <section className="quiz-view quiz-view--empty" aria-labelledby="quiz-title">
        <div className="quiz-view__heading">
          <div>
            <p className="quiz-view__eyebrow">오늘의 복습</p>
            <h1 id="quiz-title">단어 퀴즈</h1>
          </div>
        </div>

        <div className="quiz-empty-state">
          <span className="quiz-empty-state__icon" aria-hidden="true">
            <Sparkles size={28} />
          </span>
          <h2>퀴즈를 시작할 단어가 없어요</h2>
          <p>
            내 단어장에서 한국어 뜻을 입력한 단어가 생기면 이곳에서 바로
            복습할 수 있어요.
          </p>
        </div>

        <AccumulatedStats
          studied={accumulatedStats.studied}
          attempts={accumulatedStats.attempts}
          known={accumulatedStats.known}
          unknown={accumulatedStats.unknown}
          accuracy={accumulatedAccuracy}
        />
      </section>
    )
  }

  if (!quizStarted) {
    const start = Number(rangeStart)
    const end = Number(rangeEnd)
    const validRange =
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 1 &&
      end >= start &&
      end <= scopedEntries.length
    const rangeCount = validRange ? end - start + 1 : 0
    const firstEntry = validRange ? scopedEntries[start - 1] : undefined
    const lastEntry = validRange ? scopedEntries[end - 1] : undefined

    return (
      <section className="quiz-view" aria-labelledby="quiz-title">
        <div className="quiz-view__heading">
          <div>
            <p className="quiz-view__eyebrow">오늘의 복습</p>
            <h1 id="quiz-title">단어 퀴즈</h1>
            <p className="quiz-view__description">
              학습할 폴더와 단어 번호 범위를 먼저 선택하세요.
            </p>
          </div>
        </div>

        <form className="quiz-setup" onSubmit={startQuiz}>
          <div className="quiz-setup__heading">
            <span className="quiz-setup__icon" aria-hidden="true">
              <FolderOpen size={24} />
            </span>
            <div>
              <h2>퀴즈 범위 선택</h2>
              <p>선택한 폴더의 단어를 알파벳순으로 번호 매겨요.</p>
            </div>
          </div>

          <div className="quiz-setup__grid">
            <label className="quiz-setup__field quiz-setup__field--folder">
              <span>폴더</span>
              <select
                value={selectedFolderId}
                onChange={(event) =>
                  setSelectedFolderId(event.target.value as QuizFolderFilter)
                }
                disabled={foldersLoading}
              >
                <option value="all">전체 단어 ({eligibleEntries.length})</option>
                <option value="unfiled">미분류 ({unfiledCount})</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name} ({folderCounts.get(folder.id) ?? 0})
                  </option>
                ))}
              </select>
            </label>

            <label className="quiz-setup__field">
              <span>시작 번호</span>
              <input
                type="number"
                min={1}
                max={Math.max(scopedEntries.length, 1)}
                value={rangeStart}
                onChange={(event) => setRangeStart(event.target.value)}
                disabled={scopedEntries.length === 0}
                inputMode="numeric"
              />
            </label>

            <label className="quiz-setup__field">
              <span>끝 번호</span>
              <input
                type="number"
                min={1}
                max={Math.max(scopedEntries.length, 1)}
                value={rangeEnd}
                onChange={(event) => setRangeEnd(event.target.value)}
                disabled={scopedEntries.length === 0}
                inputMode="numeric"
              />
            </label>
          </div>

          <div className="quiz-setup__summary" aria-live="polite">
            <strong>{selectedFolderLabel}</strong>
            {validRange && firstEntry && lastEntry ? (
              <span>
                {start}번 {firstEntry.word} → {end}번 {lastEntry.word} · 총{' '}
                {rangeCount}개
              </span>
            ) : (
              <span>이 폴더에는 뜻이 입력된 단어가 없어요.</span>
            )}
          </div>

          {(folderError || setupError) && (
            <p className="quiz-error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              {setupError || folderError}
            </p>
          )}

          <button
            type="submit"
            className="button button--primary quiz-setup__start"
            disabled={!validRange || foldersLoading}
          >
            <Play size={18} aria-hidden="true" />
            {validRange ? `${rangeCount}개로 퀴즈 시작` : '퀴즈 시작'}
          </button>
        </form>

        <AccumulatedStats
          studied={accumulatedStats.studied}
          attempts={accumulatedStats.attempts}
          known={accumulatedStats.known}
          unknown={accumulatedStats.unknown}
          accuracy={accumulatedAccuracy}
        />
      </section>
    )
  }

  return (
    <section className="quiz-view" aria-labelledby="quiz-title">
      <div className="quiz-view__heading">
        <div>
          <p className="quiz-view__eyebrow">오늘의 복습</p>
          <h1 id="quiz-title">단어 퀴즈</h1>
          <p className="quiz-view__description">
            {selectedFolderLabel} · {rangeStart}~{rangeEnd}번 · 뜻을 떠올린 뒤
            카드를 뒤집어 확인해 보세요.
          </p>
        </div>

        <div className="quiz-session-stats" aria-label="이번 학습 결과">
          <span className="quiz-session-stats__item quiz-session-stats__item--known">
            <Check size={16} aria-hidden="true" />
            알아요 <strong>{sessionStats.known}</strong>
          </span>
          <span className="quiz-session-stats__item quiz-session-stats__item--unknown">
            <X size={16} aria-hidden="true" />
            아직 몰라요 <strong>{sessionStats.unknown}</strong>
          </span>
        </div>
      </div>

      <div className="quiz-progress" aria-label="퀴즈 진행률">
        <div className="quiz-progress__labels">
          <span>
            {isFinished ? '학습 완료' : `${currentIndex + 1}번째 단어`}
          </span>
          <strong>
            {isFinished ? queue.length : currentIndex + 1} / {queue.length}
          </strong>
        </div>
        <div
          className="quiz-progress__track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={queue.length}
          aria-valuenow={isFinished ? queue.length : currentIndex + 1}
          aria-valuetext={`${isFinished ? queue.length : currentIndex + 1}개 중 ${queue.length}개`}
        >
          <span
            className="quiz-progress__fill"
            style={{
              width: `${
                ((isFinished ? queue.length : currentIndex + 1) / queue.length) *
                100
              }%`,
            }}
          />
        </div>
      </div>

      {isFinished ? (
        <div className="quiz-summary" aria-labelledby="quiz-summary-title">
          <span className="quiz-summary__icon" aria-hidden="true">
            <Sparkles size={30} />
          </span>
          <p className="quiz-summary__eyebrow">한 세트 완료</p>
          <h2 id="quiz-summary-title">오늘 학습을 마쳤어요!</h2>
          <p>총 {sessionTotal}개의 단어를 끝까지 확인했어요.</p>

          <dl className="quiz-summary__results">
            <div>
              <dt>알아요</dt>
              <dd>{sessionStats.known}</dd>
            </div>
            <div>
              <dt>아직 몰라요</dt>
              <dd>{sessionStats.unknown}</dd>
            </div>
            <div>
              <dt>이번 기억률</dt>
              <dd>{sessionAccuracy}%</dd>
            </div>
          </dl>

          <div className="quiz-summary__actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={returnToSetup}
            >
              범위 다시 선택
            </button>
            <button
              type="button"
              className="button button--primary quiz-summary__restart"
              onClick={restartQuiz}
            >
              <RefreshCw size={18} aria-hidden="true" />
              다시 섞어서 학습하기
            </button>
          </div>
        </div>
      ) : (
        <div className="quiz-stage">
          <article
            className={`quiz-card${isRevealed ? ' quiz-card--revealed' : ''}`}
            aria-labelledby="quiz-word"
          >
            <div className="quiz-card__front">
              <p className="quiz-card__prompt">이 단어의 뜻은 무엇일까요?</p>
              <div className="quiz-card__word-row">
                <h2 id="quiz-word" className="quiz-card__word" lang="en">
                  {currentEntry.word}
                </h2>
                <button
                  type="button"
                  className="icon-button quiz-card__speak"
                  onClick={() => onSpeak(currentEntry.word)}
                  disabled={!speechAvailable}
                  aria-label={`${currentEntry.word} 발음 듣기`}
                  title={
                    speechAvailable
                      ? '영어 발음 듣기'
                      : '이 브라우저에서는 음성 재생을 지원하지 않아요'
                  }
                >
                  <Volume2 size={21} aria-hidden="true" />
                </button>
              </div>
            </div>

            {isRevealed ? (
              <div id="quiz-answer" className="quiz-card__answer">
                <p className="quiz-card__answer-label">뜻</p>
                <p className="quiz-card__meaning">{currentEntry.meaning}</p>

                {(currentEntry.partOfSpeech.trim() ||
                  currentEntry.memo.trim()) && (
                  <dl className="quiz-card__details">
                    {currentEntry.partOfSpeech.trim() && (
                      <div>
                        <dt>품사</dt>
                        <dd>{currentEntry.partOfSpeech}</dd>
                      </div>
                    )}
                    {currentEntry.memo.trim() && (
                      <div>
                        <dt>메모</dt>
                        <dd>{currentEntry.memo}</dd>
                      </div>
                    )}
                  </dl>
                )}
              </div>
            ) : (
              <div className="quiz-card__concealed" aria-hidden="true">
                <Eye size={18} />
                아직 답이 가려져 있어요
              </div>
            )}
          </article>

          <div className="quiz-actions">
            {!isRevealed ? (
              <button
                type="button"
                className="button button--primary quiz-actions__reveal"
                onClick={revealAnswer}
                aria-controls="quiz-answer"
                aria-expanded={false}
              >
                <Eye size={19} aria-hidden="true" />
                뜻 확인하기
                <kbd>Space</kbd>
              </button>
            ) : (
              <div className="quiz-actions__rating" aria-label="학습 결과 선택">
                <button
                  type="button"
                  className="button quiz-actions__unknown"
                  onClick={() => void rateCurrentEntry('unknown')}
                  disabled={isRating}
                >
                  <X size={19} aria-hidden="true" />
                  아직 몰라요
                  <kbd>1</kbd>
                </button>
                <button
                  type="button"
                  className="button button--primary quiz-actions__known"
                  onClick={() => void rateCurrentEntry('known')}
                  disabled={isRating}
                >
                  <Check size={19} aria-hidden="true" />
                  알아요
                  <kbd>2</kbd>
                </button>
              </div>
            )}
          </div>

          {ratingError && (
            <p className="quiz-error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              {ratingError}
            </p>
          )}

          <p className="quiz-keyboard-help">
            <Keyboard size={16} aria-hidden="true" />
            <span>
              키보드: <kbd>Space</kbd> 뜻 보기 · <kbd>1</kbd> 아직 몰라요 ·{' '}
              <kbd>2</kbd> 알아요
            </span>
          </p>
        </div>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {isFinished
          ? `퀴즈 완료. 알아요 ${sessionStats.known}개, 아직 몰라요 ${sessionStats.unknown}개입니다.`
          : isRating
            ? '학습 결과를 저장하고 있습니다.'
            : isRevealed
              ? `${currentEntry.word}의 뜻은 ${currentEntry.meaning}입니다. 알아요 또는 아직 몰라요를 선택하세요.`
              : `${queue.length}개 중 ${currentIndex + 1}번째 단어, ${currentEntry.word}입니다. 뜻을 생각한 뒤 확인하세요.`}
      </p>

      <AccumulatedStats
        studied={accumulatedStats.studied}
        attempts={accumulatedStats.attempts}
        known={accumulatedStats.known}
        unknown={accumulatedStats.unknown}
        accuracy={accumulatedAccuracy}
      />
    </section>
  )
}

interface AccumulatedStatsProps {
  studied: number
  attempts: number
  known: number
  unknown: number
  accuracy: number
}

function AccumulatedStats({
  studied,
  attempts,
  known,
  unknown,
  accuracy,
}: AccumulatedStatsProps) {
  return (
    <section className="quiz-lifetime-stats" aria-labelledby="lifetime-stats-title">
      <div className="quiz-lifetime-stats__heading">
        <BarChart3 size={20} aria-hidden="true" />
        <div>
          <h2 id="lifetime-stats-title">누적 학습 통계</h2>
          <p>브라우저에 저장된 모든 퀴즈 기록이에요.</p>
        </div>
      </div>

      <dl className="quiz-lifetime-stats__grid">
        <div>
          <dt>학습한 단어</dt>
          <dd>{studied}</dd>
        </div>
        <div>
          <dt>누적 학습</dt>
          <dd>{attempts}</dd>
        </div>
        <div>
          <dt>알아요</dt>
          <dd>{known}</dd>
        </div>
        <div>
          <dt>아직 몰라요</dt>
          <dd>{unknown}</dd>
        </div>
        <div>
          <dt>누적 기억률</dt>
          <dd>{accuracy}%</dd>
        </div>
      </dl>
    </section>
  )
}
