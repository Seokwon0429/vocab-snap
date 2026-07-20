import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Camera,
  Check,
  CheckCheck,
  FileImage,
  ImagePlus,
  LockKeyhole,
  Pencil,
  RotateCcw,
  ScanText,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import type { WordEntry } from '../types'
import { addMany } from '../lib/db'
import {
  OcrError,
  recognizeEnglishText,
  validateImageFile,
  type OcrProgress,
} from '../lib/ocr'
import {
  extractEnglishWords,
  isPlausibleEnglishWord,
  normalizeEnglishWord,
} from '../lib/wordExtraction'
import type { ToastKind } from './Toast'

interface PhotoAddViewProps {
  entries: WordEntry[]
  onWordsAdded: (count: number) => Promise<void>
  notify: (text: string, kind?: ToastKind) => void
}

interface ReviewItem {
  id: string
  word: string
  originalWord: string
  selected: boolean
  repeatedInPhoto: boolean
}

const initialProgress: OcrProgress = {
  progress: 0,
  percent: 0,
  stage: 'preprocessing',
  message: '사진을 준비하고 있어요.',
}

function makeReviewId(index: number) {
  return `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`
}

export function PhotoAddView({ entries, onWordsAdded, notify }: PhotoAddViewProps) {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState<OcrProgress>(initialProgress)
  const [error, setError] = useState('')
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [rawText, setRawText] = useState('')
  const [showRawText, setShowRawText] = useState(false)
  const [saving, setSaving] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const existingWords = useMemo(
    () => new Set(entries.map((entry) => entry.normalizedWord)),
    [entries],
  )

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const resetAll = () => {
    abortRef.current?.abort()
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null)
    setPreviewUrl('')
    setError('')
    setReviewItems([])
    setRawText('')
    setShowRawText(false)
    setProgress(initialProgress)
    if (uploadInputRef.current) uploadInputRef.current.value = ''
    if (cameraInputRef.current) cameraInputRef.current.value = ''
  }

  const chooseFile = (candidate?: File) => {
    if (!candidate || processing) return
    const validation = validateImageFile(candidate)
    if (!validation.ok) {
      setError(validation.message)
      return
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(candidate)
    setPreviewUrl(URL.createObjectURL(candidate))
    setError('')
    setReviewItems([])
    setRawText('')
    setProgress(initialProgress)
  }

  const startRecognition = async () => {
    if (!file || processing) return
    setProcessing(true)
    setError('')
    setProgress(initialProgress)
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const result = await recognizeEnglishText(file, {
        signal: controller.signal,
        onProgress: setProgress,
        preprocess: {
          maxDimension: 2400,
          minDimension: 1500,
          maxPixels: 12_000_000,
          grayscale: true,
          autoContrast: true,
          contrast: 22,
        },
      })
      const extracted = extractEnglishWords(result.text, {
        existingWords,
        minLetters: 2,
      })
      if (extracted.words.length === 0) {
        throw new OcrError(
          'no_text_detected',
          '저장할 만한 영어 단어를 찾지 못했어요. 글자가 더 선명한 사진으로 다시 시도해 주세요.',
        )
      }
      const repeated = new Set(extracted.duplicateWords)
      setRawText(result.text)
      setReviewItems(
        extracted.words.map((word, index) => ({
          id: makeReviewId(index),
          word,
          originalWord: word,
          selected: !existingWords.has(word),
          repeatedInPhoto: repeated.has(word),
        })),
      )
      notify(
        `${extracted.words.length}개 단어를 찾았어요. 저장할 단어를 확인해 주세요.`,
        'success',
      )
    } catch (recognitionError) {
      if (recognitionError instanceof OcrError && recognitionError.code === 'cancelled') {
        notify('사진 인식을 취소했어요.', 'info')
      } else {
        setError(
          recognitionError instanceof Error
            ? recognitionError.message
            : '사진을 인식하지 못했어요. 다시 시도해 주세요.',
        )
      }
    } finally {
      setProcessing(false)
      abortRef.current = null
    }
  }

  const statusFor = (item: ReviewItem) => {
    const normalized = normalizeEnglishWord(item.word)
    if (!isPlausibleEnglishWord(normalized)) return 'invalid' as const
    if (existingWords.has(normalized)) return 'existing' as const
    const sameWord = reviewItems.filter(
      (candidate) => normalizeEnglishWord(candidate.word) === normalized,
    )
    if (sameWord.length > 1 && sameWord[0].id !== item.id) return 'review-duplicate' as const
    return 'new' as const
  }

  const availableItems = reviewItems.filter((item) => statusFor(item) === 'new')
  const existingItems = reviewItems.filter((item) => statusFor(item) === 'existing')
  const problemItems = reviewItems.filter((item) => {
    const status = statusFor(item)
    return status === 'invalid' || status === 'review-duplicate'
  })
  const selectedCount = availableItems.filter((item) => item.selected).length
  const allAvailableSelected =
    availableItems.length > 0 && availableItems.every((item) => item.selected)

  const updateWord = (id: string, value: string) => {
    setReviewItems((current) =>
      current.map((item) => (item.id === id ? { ...item, word: value, selected: true } : item)),
    )
  }

  const toggleWord = (id: string) => {
    setReviewItems((current) =>
      current.map((item) =>
        item.id === id && statusFor(item) === 'new'
          ? { ...item, selected: !item.selected }
          : item,
      ),
    )
  }

  const toggleAll = () => {
    setReviewItems((current) =>
      current.map((item) =>
        statusFor(item) === 'new' ? { ...item, selected: !allAvailableSelected } : item,
      ),
    )
  }

  const removeReviewItem = (id: string) => {
    setReviewItems((current) => current.filter((item) => item.id !== id))
  }

  const saveSelected = async () => {
    const selected = reviewItems
      .filter((item) => item.selected && statusFor(item) === 'new')
      .map((item) => ({ word: normalizeEnglishWord(item.word) }))
    if (selected.length === 0) return

    setSaving(true)
    try {
      const result = await addMany(selected)
      await onWordsAdded(result.added.length)
      resetAll()
      if (result.duplicates.length) {
        notify(
          `${result.added.length}개를 추가했고, 방금 중복된 ${result.duplicates.length}개는 건너뛰었어요.`,
          'info',
        )
      }
    } catch {
      notify('선택한 단어를 저장하지 못했어요. 다시 시도해 주세요.', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (reviewItems.length > 0) {
    return (
      <section className="page review-page" aria-labelledby="review-title">
        <button type="button" className="back-button" onClick={resetAll}>
          <ArrowLeft size={18} aria-hidden="true" /> 다른 사진 선택
        </button>
        <div className="page-heading review-heading">
          <div>
            <span className="eyebrow">CHECK BEFORE SAVE</span>
            <h1 id="review-title">인식 결과를 확인해 주세요</h1>
            <p>틀린 단어는 바로 고치고, 필요한 단어만 골라 저장할 수 있어요.</p>
          </div>
          <div className="review-count-pill">
            <strong>{selectedCount}</strong>
            <span>개 선택됨</span>
          </div>
        </div>

        <div className="review-layout">
          <aside className="review-preview surface">
            <div className="review-image-wrap">
              <img src={previewUrl} alt="선택한 영어 문장 사진 미리보기" />
            </div>
            <button type="button" className="text-button raw-toggle" onClick={() => setShowRawText((value) => !value)} aria-expanded={showRawText}>
              <ScanText size={17} aria-hidden="true" /> {showRawText ? '인식 문장 접기' : '인식 문장 보기'}
            </button>
            {showRawText ? <pre className="raw-text" lang="en">{rawText}</pre> : null}
            <div className="privacy-note compact">
              <LockKeyhole size={16} aria-hidden="true" />
              <span>사진과 인식 결과는 이 기기 밖으로 전송되지 않아요.</span>
            </div>
          </aside>

          <div className="review-panel surface">
            <div className="review-toolbar">
              <div>
                <h2>새로 추가할 단어</h2>
                <p>{availableItems.length}개 저장 가능</p>
              </div>
              <button type="button" className="button button-quiet compact-button" onClick={toggleAll} disabled={availableItems.length === 0}>
                {allAvailableSelected ? <X size={16} aria-hidden="true" /> : <CheckCheck size={16} aria-hidden="true" />}
                {allAvailableSelected ? '전체 해제' : '전체 선택'}
              </button>
            </div>

            <div className="review-word-list">
              {availableItems.map((item) => (
                <div className={`review-word-row ${item.selected ? 'is-selected' : ''}`} key={item.id}>
                  <label className="review-checkbox">
                    <input type="checkbox" checked={item.selected} onChange={() => toggleWord(item.id)} />
                    <span className="custom-check"><Check size={14} aria-hidden="true" /></span>
                    <span className="sr-only">{item.word} 선택</span>
                  </label>
                  <div className="editable-word">
                    <Pencil size={15} aria-hidden="true" />
                    <input value={item.word} onChange={(event) => updateWord(item.id, event.target.value)} aria-label={`${item.originalWord} 단어 수정`} lang="en" spellCheck={false} />
                  </div>
                  {item.repeatedInPhoto ? <span className="mini-badge">여러 번 발견</span> : null}
                  <button type="button" className="icon-button danger" onClick={() => removeReviewItem(item.id)} aria-label={`${item.word} 결과에서 삭제`}>
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {availableItems.length === 0 ? (
                <div className="inline-empty">새로 저장할 수 있는 단어가 없어요.</div>
              ) : null}
            </div>

            {existingItems.length > 0 ? (
              <details className="duplicate-section" open>
                <summary>이미 단어장에 있는 단어 <span>{existingItems.length}</span></summary>
                <div className="duplicate-chips">
                  {existingItems.map((item) => (
                    <div className="duplicate-chip" key={item.id}>
                      <span lang="en">{normalizeEnglishWord(item.word) || item.word}</span>
                      <button type="button" onClick={() => removeReviewItem(item.id)} aria-label={`${item.word} 결과에서 삭제`}><X size={14} aria-hidden="true" /></button>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}

            {problemItems.length > 0 ? (
              <details className="duplicate-section warning-section">
                <summary>수정이 필요한 항목 <span>{problemItems.length}</span></summary>
                <div className="review-word-list problem-list">
                  {problemItems.map((item) => (
                    <div className="review-word-row" key={item.id}>
                      <div className="editable-word">
                        <Pencil size={15} aria-hidden="true" />
                        <input value={item.word} onChange={(event) => updateWord(item.id, event.target.value)} aria-label={`${item.originalWord} 단어 수정`} lang="en" spellCheck={false} />
                      </div>
                      <span className="validation-label">{statusFor(item) === 'invalid' ? '영문 단어 확인' : '검토 목록 중복'}</span>
                      <button type="button" className="icon-button danger" onClick={() => removeReviewItem(item.id)} aria-label={`${item.word} 결과에서 삭제`}><Trash2 size={17} aria-hidden="true" /></button>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}

            <div className="review-actions">
              <button type="button" className="button button-quiet" onClick={resetAll}>취소</button>
              <button type="button" className="button button-primary button-wide" onClick={() => void saveSelected()} disabled={selectedCount === 0 || saving}>
                {saving ? <span className="spinner small" aria-hidden="true" /> : <Sparkles size={18} aria-hidden="true" />}
                {saving ? '저장하는 중…' : `선택한 ${selectedCount}개 단어 추가`}
              </button>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="page photo-page" aria-labelledby="photo-title">
      <div className="hero-grid">
        <div className="hero-copy">
          <span className="eyebrow"><span aria-hidden="true">✦</span> PRIVATE · FREE · IN YOUR BROWSER</span>
          <h1 id="photo-title">사진 속 영어를<br /><em>오늘의 단어장</em>으로.</h1>
          <p>책, 프린트, 안내문을 찍으면 영어 단어만 골라 드려요. 저장 전 한 번 더 확인하고 나만의 뜻을 채워 보세요.</p>
          <div className="feature-points" aria-label="주요 특징">
            <span><Check size={15} aria-hidden="true" /> 기기 안에서만 OCR</span>
            <span><Check size={15} aria-hidden="true" /> 중복 자동 분류</span>
            <span><Check size={15} aria-hidden="true" /> 무료·API 키 불필요</span>
          </div>
        </div>

        <div className="upload-card surface">
          <div className="upload-card-header">
            <div className="step-badge">01</div>
            <div><h2>영어가 보이는 사진을 올려 주세요</h2><p>JPG, PNG, WebP, BMP, GIF · 최대 15MB</p></div>
          </div>

          <input ref={uploadInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/gif" onChange={(event) => chooseFile(event.target.files?.[0])} />
          <input ref={cameraInputRef} className="sr-only" type="file" accept="image/*" capture="environment" onChange={(event) => chooseFile(event.target.files?.[0])} />

          {!file ? (
            <div
              className={`drop-zone ${isDragging ? 'is-dragging' : ''}`}
              onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { event.preventDefault(); if (event.currentTarget === event.target) setIsDragging(false) }}
              onDrop={(event) => { event.preventDefault(); setIsDragging(false); chooseFile(event.dataTransfer.files[0]) }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); uploadInputRef.current?.click() } }}
              role="button"
              tabIndex={0}
              aria-label="사진 업로드. 클릭하거나 파일을 끌어 놓으세요."
              onClick={() => uploadInputRef.current?.click()}
            >
              <div className="drop-illustration" aria-hidden="true">
                <div className="photo-sheet"><span>Aa</span><i /></div>
                <div className="upload-bubble"><UploadCloud size={21} /></div>
              </div>
              <strong>사진을 끌어다 놓거나 눌러서 선택</strong>
              <span>글자가 크고 반듯할수록 더 정확해요</span>
            </div>
          ) : (
            <div className="selected-photo">
              <div className="selected-image-wrap">
                <img src={previewUrl} alt="인식할 영어 문장 사진 미리보기" />
                <button type="button" className="remove-photo" onClick={resetAll} disabled={processing} aria-label="선택한 사진 제거"><X size={18} aria-hidden="true" /></button>
              </div>
              <div className="selected-file-info">
                <FileImage size={20} aria-hidden="true" />
                <div><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} MB</span></div>
              </div>
            </div>
          )}

          {error ? <div className="error-message" role="alert"><span>!</span><p>{error}</p><button type="button" onClick={() => setError('')} aria-label="오류 메시지 닫기"><X size={15} /></button></div> : null}

          {processing ? (
            <div className="ocr-progress" aria-live="polite">
              <div className="progress-copy"><span>{progress.message}</span><strong>{progress.percent}%</strong></div>
              <progress value={progress.percent} max="100">{progress.percent}%</progress>
              <div className="progress-meta"><span>사진 전처리</span><span>영어 인식</span><span>단어 추출</span></div>
              <button type="button" className="text-button cancel-ocr" onClick={() => abortRef.current?.abort()}>인식 취소</button>
            </div>
          ) : (
            <div className="upload-actions">
              {!file ? (
                <>
                  <button type="button" className="button button-primary" onClick={() => uploadInputRef.current?.click()}><ImagePlus size={18} aria-hidden="true" /> 사진 선택</button>
                  <button type="button" className="button button-secondary" onClick={() => cameraInputRef.current?.click()}><Camera size={18} aria-hidden="true" /> 카메라로 촬영</button>
                </>
              ) : (
                <>
                  <button type="button" className="button button-primary button-wide" onClick={() => void startRecognition()}><ScanText size={19} aria-hidden="true" /> 영어 단어 인식 시작</button>
                  <button type="button" className="button button-quiet" onClick={() => uploadInputRef.current?.click()}><RotateCcw size={17} aria-hidden="true" /> 사진 바꾸기</button>
                </>
              )}
            </div>
          )}

          <div className="privacy-note">
            <LockKeyhole size={18} aria-hidden="true" />
            <div><strong>사진은 업로드되지 않아요</strong><span>인식과 전처리는 이 브라우저 안에서만 실행됩니다.</span></div>
          </div>
        </div>
      </div>

      <div className="how-it-works" aria-labelledby="how-title">
        <div className="section-heading"><span className="eyebrow">HOW IT WORKS</span><h2 id="how-title">세 단계면 충분해요</h2></div>
        <ol className="steps-grid">
          <li><span className="step-number">01</span><div className="step-icon"><Camera size={22} /></div><h3>사진 선택</h3><p>문장이나 단어가 보이는 사진을 고릅니다.</p></li>
          <li><span className="step-number">02</span><div className="step-icon"><ScanText size={22} /></div><h3>브라우저 인식</h3><p>사진을 다듬고 영어 단어만 찾아냅니다.</p></li>
          <li><span className="step-number">03</span><div className="step-icon"><BookOpenIcon /></div><h3>확인 후 저장</h3><p>필요한 단어를 고쳐 골라서 단어장에 담습니다.</p></li>
        </ol>
      </div>
    </section>
  )
}

function BookOpenIcon() {
  return <CheckCheck size={22} aria-hidden="true" />
}
