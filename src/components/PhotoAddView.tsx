import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Camera,
  Check,
  CheckCheck,
  ClipboardPaste,
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
import { addMany } from '../lib/storage'
import {
  enrichWithKoreanDefinitions,
  lookupKoreanDefinitions,
  type KoreanDictionaryEntry,
} from '../lib/koreanDictionary'
import {
  OcrError,
  recognizeImageText,
  validateImageFile,
  type OcrProgress,
  type OcrWordEvidence,
} from '../lib/ocr'
import {
  compareOcrMeaningWithDictionary,
  correctOcrKoreanSpacing,
  findCrossSwappedMeaningWords,
  pairOcrLinesWithKoreanMeanings,
  type OcrMeaningCandidate,
} from '../lib/ocrMeaningPairing'
import {
  suggestCorrectionsForWords,
  type CorrectionSuggestion,
} from '../lib/wordCorrection'
import {
  extractEnglishOcrCandidates,
  extractEnglishWords,
  isPlausibleEnglishWord,
  normalizeEnglishWord,
} from '../lib/wordExtraction'
import { parseNumberedTwoColumnVocabulary } from '../lib/numberedVocabularyLayout'
import { parsePastedVocabularyText } from '../lib/pastedTextParser'
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
  recovered: boolean
  requiresManualValidation: boolean
  confidence?: number
  suggestions: CorrectionSuggestion[]
  reviewState: 'clear' | 'pending' | 'kept' | 'corrected' | 'edited'
  meaning: string
  partOfSpeech: string
  dictionaryMeaning: string
  dictionaryPartOfSpeech: string
  meaningCandidate?: OcrMeaningCandidate
  meaningEditedByUser: boolean
  meaningSpacingCorrected: boolean
  meaningState:
    | 'exact'
    | 'related'
    | 'uncertain'
    | 'mismatch'
    | 'dictionary'
    | 'confirmed'
    | 'edited'
    | 'empty'
}

interface RecognitionSummary {
  confidence: number
  passCount: number
  detectedKorean: boolean
  hiddenLowConfidenceCount: number
  numberedVocabularyDetected: boolean
  layoutEntryCount: number
  excludedCandidateCount: number
}

const LOW_CONFIDENCE_THRESHOLD = 75
const MIN_VISIBLE_WORD_CONFIDENCE = 20
const LOW_CONFIDENCE_REVIEW_CEILING = 50
const VERY_LOW_CONFIDENCE_CEILING = 40

const initialProgress: OcrProgress = {
  progress: 0,
  percent: 0,
  stage: 'preprocessing',
  message: '사진을 준비하고 있어요.',
}

function makeReviewId(index: number) {
  return `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`
}

type MeaningReviewFields = Pick<
  ReviewItem,
  | 'meaning'
  | 'partOfSpeech'
  | 'dictionaryMeaning'
  | 'dictionaryPartOfSpeech'
  | 'meaningCandidate'
  | 'meaningSpacingCorrected'
  | 'meaningState'
>

function meaningReviewForWord(
  word: string,
  candidate: OcrMeaningCandidate | undefined,
  dictionary: KoreanDictionaryEntry | undefined,
  mismatch = false,
): MeaningReviewFields {
  const dictionaryMeaning = dictionary?.meaning.trim() ?? ''
  const dictionaryPartOfSpeech = dictionary?.partOfSpeech.trim() ?? ''
  if (candidate?.meaning.trim()) {
    const correctedMeaning = correctOcrKoreanSpacing(candidate.meaning, dictionary)
    const meaningSpacingCorrected = correctedMeaning !== candidate.meaning.trim()
    const photographedParts = new Set(candidate.partOfSpeech.split('·').filter(Boolean))
    const dictionaryParts = new Set(dictionaryPartOfSpeech.split('·').filter(Boolean))
    const partOfSpeechConflict = photographedParts.size > 0
      && dictionaryParts.size > 0
      && ![...photographedParts].some((part) => dictionaryParts.has(part))
    const agreement = mismatch
      ? 'mismatch'
      : partOfSpeechConflict
        ? 'uncertain'
        : compareOcrMeaningWithDictionary(
            {
              ...candidate,
              word: normalizeEnglishWord(word),
              meaning: correctedMeaning,
            },
            dictionary,
          )
    return {
      meaning: correctedMeaning,
      partOfSpeech: candidate.partOfSpeech.trim() || dictionaryPartOfSpeech,
      dictionaryMeaning,
      dictionaryPartOfSpeech,
      meaningCandidate: candidate,
      meaningSpacingCorrected,
      meaningState: agreement,
    }
  }
  if (dictionaryMeaning) {
    return {
      meaning: dictionaryMeaning,
      partOfSpeech: dictionaryPartOfSpeech,
      dictionaryMeaning,
      dictionaryPartOfSpeech,
      meaningCandidate: candidate,
      meaningSpacingCorrected: false,
      meaningState: 'dictionary',
    }
  }
  return {
    meaning: '',
    partOfSpeech: dictionaryPartOfSpeech,
    dictionaryMeaning,
    dictionaryPartOfSpeech,
    meaningCandidate: candidate,
    meaningSpacingCorrected: false,
    meaningState: 'empty',
  }
}

function meaningReviewAfterWordChange(
  item: ReviewItem,
  word: string,
  dictionary: KoreanDictionaryEntry | undefined,
): MeaningReviewFields {
  const revised = meaningReviewForWord(word, item.meaningCandidate, dictionary)
  if (!item.meaningEditedByUser || !item.meaning.trim()) return revised

  return {
    ...revised,
    meaning: item.meaning,
    partOfSpeech: item.partOfSpeech,
    meaningSpacingCorrected: false,
    meaningState: 'uncertain',
  }
}

function meaningStateNeedsReview(state: ReviewItem['meaningState']) {
  return state === 'related'
    || state === 'uncertain'
    || state === 'mismatch'
}

function meaningNeedsReview(item: ReviewItem) {
  return meaningStateNeedsReview(item.meaningState)
}

function meaningStateLabel(item: ReviewItem) {
  if (item.meaningState === 'exact' && item.meaningSpacingCorrected) {
    return '띄어쓰기 자동 보정·사전 일치'
  }
  if (item.meaningState === 'exact') return '사전과 정확히 일치'
  if (item.meaningState === 'related') return '사전 뜻과 유사'
  if (item.meaningState === 'uncertain') return '뜻 확인 필요'
  if (item.meaningState === 'mismatch') return '다른 행의 뜻일 가능성'
  if (item.meaningState === 'dictionary') return '내장 사전 뜻'
  if (item.meaningState === 'confirmed') return '사진 뜻 확인됨'
  if (item.meaningState === 'edited') return '직접 수정한 뜻'
  return '뜻 없음'
}

function isLowConfidenceReviewItem(item: ReviewItem) {
  return item.confidence !== undefined
    && item.confidence >= MIN_VISIBLE_WORD_CONFIDENCE
    && item.confidence < LOW_CONFIDENCE_REVIEW_CEILING
}

function isVeryLowConfidenceItem(item: ReviewItem) {
  return item.confidence !== undefined
    && item.confidence < VERY_LOW_CONFIDENCE_CEILING
}

function confidenceEvidenceForWords(evidence: readonly OcrWordEvidence[]) {
  const confidenceByWord = new Map<string, number>()
  const alternativesByWord = new Map<string, string[]>()
  const occurrenceByWord = new Map<string, number>()

  for (const item of evidence) {
    const recognized = extractEnglishOcrCandidates([item.text])
    for (const word of recognized) {
      confidenceByWord.set(word, Math.max(confidenceByWord.get(word) ?? 0, item.confidence))
      if (!item.recoveredFromAlternatePass) {
        occurrenceByWord.set(word, (occurrenceByWord.get(word) ?? 0) + 1)
      }
      const alternatives = alternativesByWord.get(word) ?? []
      for (const rawAlternative of item.alternatives) {
        for (const alternative of extractEnglishOcrCandidates([rawAlternative])) {
          if (alternative !== word && !alternatives.includes(alternative)) alternatives.push(alternative)
        }
      }
      alternativesByWord.set(word, alternatives.slice(0, 3))
    }
  }

  const repeatedWords = new Set(
    [...occurrenceByWord.entries()]
      .filter(([, count]) => count > 1)
      .map(([word]) => word),
  )

  return { confidenceByWord, alternativesByWord, repeatedWords }
}

function boundingBoxOverlapRatio(
  left: OcrWordEvidence['bbox'],
  right: OcrWordEvidence['bbox'],
) {
  const intersectionWidth = Math.max(0, Math.min(left.x1, right.x1) - Math.max(left.x0, right.x0))
  const intersectionHeight = Math.max(0, Math.min(left.y1, right.y1) - Math.max(left.y0, right.y0))
  const intersectionArea = intersectionWidth * intersectionHeight
  const leftArea = Math.max(1, (left.x1 - left.x0) * (left.y1 - left.y0))
  const rightArea = Math.max(1, (right.x1 - right.x0) * (right.y1 - right.y0))
  return intersectionArea / Math.min(leftArea, rightArea)
}

function mergeOverlappingWordEvidence(
  anchor: OcrWordEvidence,
  consolidatedEvidence: readonly OcrWordEvidence[],
): OcrWordEvidence {
  let bestMatch: OcrWordEvidence | undefined
  let bestOverlap = 0

  for (const candidate of consolidatedEvidence) {
    const overlap = boundingBoxOverlapRatio(anchor.bbox, candidate.bbox)
    const anchorArea = Math.max(1, (anchor.bbox.x1 - anchor.bbox.x0) * (anchor.bbox.y1 - anchor.bbox.y0))
    const candidateArea = Math.max(1, (candidate.bbox.x1 - candidate.bbox.x0) * (candidate.bbox.y1 - candidate.bbox.y0))
    const areaRatio = Math.max(anchorArea, candidateArea) / Math.min(anchorArea, candidateArea)
    if (
      overlap >= 0.55
      && areaRatio <= 1.6
      && (overlap > bestOverlap || (overlap === bestOverlap && candidate.confidence > (bestMatch?.confidence ?? 0)))
    ) {
      bestMatch = candidate
      bestOverlap = overlap
    }
  }

  if (!bestMatch) return anchor

  const anchorText = anchor.text.normalize('NFKC').trim().toLocaleLowerCase('en-US')
  const seen = new Set([anchorText])
  const alternatives = [bestMatch.text, ...bestMatch.alternatives, ...anchor.alternatives]
    .filter((alternative) => {
      const comparable = alternative.normalize('NFKC').trim().toLocaleLowerCase('en-US')
      if (!comparable || seen.has(comparable)) return false
      seen.add(comparable)
      return true
    })
    .slice(0, 3)

  return {
    ...anchor,
    confidence: Math.max(anchor.confidence, bestMatch.confidence),
    alternatives,
    recoveredFromAlternatePass: false,
  }
}

export function PhotoAddView({ entries, onWordsAdded, notify }: PhotoAddViewProps) {
  const [sourceMode, setSourceMode] = useState<'photo' | 'text'>('photo')
  const [file, setFile] = useState<File | null>(null)
  const [pastedText, setPastedText] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState<OcrProgress>(initialProgress)
  const [error, setError] = useState('')
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [rawText, setRawText] = useState('')
  const [showRawText, setShowRawText] = useState(false)
  const [accurateRecognition, setAccurateRecognition] = useState(true)
  const [recognitionSummary, setRecognitionSummary] = useState<RecognitionSummary | null>(null)
  const [liveMessage, setLiveMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const dictionaryDefinitionsRef = useRef(new Map<string, KoreanDictionaryEntry>())
  const wordRevisionRef = useRef(new Map<string, number>())

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
    setPastedText('')
    setPreviewUrl('')
    setError('')
    setReviewItems([])
    setRawText('')
    setShowRawText(false)
    setRecognitionSummary(null)
    setLiveMessage('')
    setProgress(initialProgress)
    dictionaryDefinitionsRef.current = new Map()
    wordRevisionRef.current = new Map()
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
    setSourceMode('photo')
    setFile(candidate)
    setPastedText('')
    setPreviewUrl(URL.createObjectURL(candidate))
    setError('')
    setReviewItems([])
    setRawText('')
    setRecognitionSummary(null)
    setProgress(initialProgress)
    dictionaryDefinitionsRef.current = new Map()
    wordRevisionRef.current = new Map()
  }

  const switchSourceMode = (mode: 'photo' | 'text') => {
    if (processing || mode === sourceMode) return
    abortRef.current?.abort()
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setSourceMode(mode)
    setFile(null)
    setPreviewUrl('')
    setPastedText('')
    setError('')
    setRecognitionSummary(null)
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
      const result = await recognizeImageText(file, {
        signal: controller.signal,
        onProgress: setProgress,
        accuracyMode: accurateRecognition ? 'accurate' : 'standard',
        preprocess: {
          // Use the existing 6 MP budget more effectively on tall page photos.
          maxDimension: 4096,
          minDimension: 1600,
          maxPixels: 6_000_000,
          grayscale: true,
          autoContrast: true,
          contrast: 22,
        },
      })
      const numberedVocabulary = parseNumberedTwoColumnVocabulary(result.lines ?? [])
      let photographedMeanings = pairOcrLinesWithKoreanMeanings(result.lines ?? [])
      const extracted = extractEnglishWords(result.text, {
        existingWords,
        minLetters: 2,
      })
      const generalReviewWords = [...extracted.words]
      const generalReviewWordSet = new Set(generalReviewWords)
      const recoveredCandidates = extractEnglishOcrCandidates(
        [...(result.candidateTexts ?? [result.text]), ...result.words.map((word) => word.text)],
        { minLetters: 2, maxDigits: 2 },
      )
      for (const candidate of recoveredCandidates) {
        if (!generalReviewWordSet.has(candidate)) {
          generalReviewWordSet.add(candidate)
          generalReviewWords.push(candidate)
        }
      }

      let strictWords: Set<string>
      let reviewWords: string[]
      let activeWordEvidence: readonly OcrWordEvidence[]
      let excludedCandidateCount = 0

      if (numberedVocabulary.detected) {
        const mergedLayoutEvidence = numberedVocabulary.entries.map((entry) => (
          mergeOverlappingWordEvidence(entry.wordEvidence, result.words)
        ))
        reviewWords = numberedVocabulary.entries
          .map((entry) => normalizeEnglishWord(entry.word))
          .filter((word, index, words) => word && words.indexOf(word) === index)
        strictWords = new Set(reviewWords)
        activeWordEvidence = mergedLayoutEvidence
        excludedCandidateCount = generalReviewWords.filter((word) => !strictWords.has(word)).length
        photographedMeanings = new Map(
          numberedVocabulary.entries
            .map((entry, index) => ({ entry, wordEvidence: mergedLayoutEvidence[index] }))
            .filter(({ entry }) => entry.meaning.trim())
            .map(({ entry, wordEvidence }) => {
              const relevantEvidence = [
                entry.numberEvidence,
                wordEvidence,
                ...entry.meaningEvidence,
              ]
              return [
                normalizeEnglishWord(entry.word),
                {
                  word: normalizeEnglishWord(entry.word),
                  meaning: entry.meaning,
                  partOfSpeech: entry.partOfSpeech,
                  confidence: Math.min(...relevantEvidence.map((evidence) => evidence.confidence)),
                  layoutConfidence: 'strong' as const,
                },
              ]
            }),
        )
      } else {
        reviewWords = generalReviewWords
        strictWords = new Set(extracted.words)
        activeWordEvidence = result.words
      }

      const {
        confidenceByWord,
        alternativesByWord,
        repeatedWords: repeatedEvidenceWords,
      } = confidenceEvidenceForWords(activeWordEvidence)
      const hiddenLowConfidenceCount = reviewWords.filter((word) => {
        const confidence = confidenceByWord.get(word)
        return confidence !== undefined && confidence < MIN_VISIBLE_WORD_CONFIDENCE
      }).length
      reviewWords = reviewWords.filter((word) => {
        const confidence = confidenceByWord.get(word)
        return confidence === undefined || confidence >= MIN_VISIBLE_WORD_CONFIDENCE
      })
      if (reviewWords.length === 0) {
        throw new OcrError(
          'no_text_detected',
          hiddenLowConfidenceCount > 0
            ? '인식률 20% 이상인 영어 단어를 찾지 못했어요. 더 선명한 사진으로 다시 시도해 주세요.'
            : result.detectedKorean
              ? '한국어 문장은 읽었지만 저장할 영어 단어를 찾지 못했어요.'
              : '저장할 만한 영어 단어를 찾지 못했어요. 글자가 더 선명한 사진으로 다시 시도해 주세요.',
        )
      }
      const repeated = new Set(
        numberedVocabulary.detected
          ? repeatedEvidenceWords
          : [...extracted.duplicateWords, ...repeatedEvidenceWords],
      )
      let dictionarySuggestions = new Map<string, CorrectionSuggestion[]>()

      try {
        dictionarySuggestions = await suggestCorrectionsForWords(
          reviewWords.map((word) => ({
            word,
            confidence: confidenceByWord.get(word),
          })),
          { maxSuggestions: 3, knownWords: existingWords },
        )
      } catch {
        notify('교정 사전을 불러오지 못했지만 인식 결과는 직접 수정할 수 있어요.', 'info')
      }

      const definitionWords = new Set(reviewWords)
      for (const alternatives of alternativesByWord.values()) {
        alternatives.forEach((word) => definitionWords.add(normalizeEnglishWord(word)))
      }
      for (const suggestions of dictionarySuggestions.values()) {
        suggestions.forEach((suggestion) => (
          definitionWords.add(normalizeEnglishWord(suggestion.word))
        ))
      }
      const definitionResult = await lookupKoreanDefinitions([...definitionWords])
      dictionaryDefinitionsRef.current = definitionResult.definitions
      const crossSwappedWords = findCrossSwappedMeaningWords(
        photographedMeanings,
        definitionResult.definitions,
      )
      if (definitionResult.unavailable) {
        notify('일부 내장 뜻 사전을 읽지 못했어요. 사진에서 읽은 뜻은 직접 확인할 수 있어요.', 'info')
      }

      if (controller.signal.aborted) {
        throw new OcrError('cancelled', '사진 인식이 취소되었습니다.')
      }

      setRawText(result.text)
      setRecognitionSummary({
        confidence: result.confidence,
        passCount: result.passes.length,
        detectedKorean: result.detectedKorean,
        hiddenLowConfidenceCount,
        numberedVocabularyDetected: numberedVocabulary.detected,
        layoutEntryCount: numberedVocabulary.detected ? reviewWords.length : 0,
        excludedCandidateCount,
      })
      setReviewItems(
        reviewWords.map((word, index) => {
          const confidence = confidenceByWord.get(word)
          const recovered = !strictWords.has(word)
          const suggestions = [
            ...(alternativesByWord.get(word) ?? []).map((alternative) => ({
              word: alternative,
              rank: 0,
            })),
            ...(dictionarySuggestions.get(word) ?? []),
          ].filter((suggestion, suggestionIndex, all) => (
            suggestion.word !== word
              && isPlausibleEnglishWord(suggestion.word)
              && all.findIndex((candidate) => candidate.word === suggestion.word) === suggestionIndex
          )).slice(0, 3)
          const needsReview = !existingWords.has(word)
            && (
              recovered
              || (confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD)
              || suggestions.length > 0
            )
          const meaningReview = meaningReviewForWord(
            word,
            photographedMeanings.get(word),
            definitionResult.definitions.get(word),
            crossSwappedWords.has(word),
          )
          const needsMeaningReview = meaningStateNeedsReview(meaningReview.meaningState)

          return {
            id: makeReviewId(index),
            word,
            originalWord: word,
            selected: !existingWords.has(word) && !needsReview && !needsMeaningReview,
            repeatedInPhoto: repeated.has(word),
            recovered,
            requiresManualValidation: !isPlausibleEnglishWord(word),
            confidence,
            suggestions,
            reviewState: needsReview ? 'pending' : 'clear',
            meaningEditedByUser: false,
            ...meaningReview,
          }
        }),
      )
      const recoveredCount = reviewWords.filter((word) => !strictWords.has(word)).length
      setLiveMessage(
        numberedVocabulary.detected
          ? `번호형 단어장으로 표제어 ${reviewWords.length}개를 구분했어요.${excludedCandidateCount > 0 ? ` 본문·파생어 후보 ${excludedCandidateCount}개는 제외했어요.` : ''}`
          : recoveredCount > 0
          ? `다른 인식 결과와 불확실한 조각에서 ${recoveredCount}개 후보를 추가로 찾았어요.`
          : '교정이 필요한 단어와 인식 신뢰도를 확인해 주세요.',
      )
      notify(
        numberedVocabulary.detected
          ? `단어장 형식을 감지해 표제어 ${reviewWords.length}개와 사진 속 뜻 ${photographedMeanings.size}개를 찾았어요.${excludedCandidateCount > 0 ? ` 본문·파생어 후보 ${excludedCandidateCount}개는 제외했어요.` : ''}${hiddenLowConfidenceCount > 0 ? ` 인식률 20% 미만 표제어 ${hiddenLowConfidenceCount}개도 제외했어요.` : ''} 저장할 내용을 확인해 주세요.`
          : `${reviewWords.length}개 영어 후보와 사진 속 뜻 ${photographedMeanings.size}개를 찾았어요.${hiddenLowConfidenceCount > 0 ? ` 인식률 20% 미만 ${hiddenLowConfidenceCount}개는 제외했어요.` : ''} 저장할 내용을 확인해 주세요.`,
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

  const startTextRecognition = async () => {
    if (processing) return
    const text = pastedText.trim()
    if (!text) {
      setError('분석할 텍스트를 붙여넣어 주세요.')
      return
    }

    setProcessing(true)
    setError('')
    try {
      const parsed = parsePastedVocabularyText(text)
      if (parsed.candidates.length === 0) {
        throw new Error('붙여넣은 내용에서 영어 단어를 찾지 못했어요.')
      }

      const reviewWords = parsed.candidates.map((candidate) => candidate.word)
      const pastedMeanings = new Map<string, OcrMeaningCandidate>(
        parsed.candidates
          .filter((candidate) => candidate.explicitMeaning)
          .map((candidate) => [
            candidate.word,
            {
              word: candidate.word,
              meaning: candidate.meaning,
              partOfSpeech: candidate.partOfSpeech,
              confidence: 100,
              layoutConfidence: 'strong' as const,
            },
          ]),
      )
      let dictionarySuggestions = new Map<string, CorrectionSuggestion[]>()
      try {
        dictionarySuggestions = await suggestCorrectionsForWords(
          reviewWords.map((word) => ({ word })),
          { maxSuggestions: 3, knownWords: existingWords },
        )
      } catch {
        notify('교정 사전을 불러오지 못했지만 결과는 직접 수정할 수 있어요.', 'info')
      }

      const definitionWords = new Set(reviewWords)
      for (const suggestions of dictionarySuggestions.values()) {
        suggestions.forEach((suggestion) => definitionWords.add(normalizeEnglishWord(suggestion.word)))
      }
      const definitionResult = await lookupKoreanDefinitions([...definitionWords])
      dictionaryDefinitionsRef.current = definitionResult.definitions
      const crossSwappedWords = findCrossSwappedMeaningWords(
        pastedMeanings,
        definitionResult.definitions,
      )

      const repeated = new Set(parsed.duplicateWords)
      setRawText(text)
      setShowRawText(true)
      setRecognitionSummary(null)
      setReviewItems(
        reviewWords.map((word, index) => {
          const suggestions = (dictionarySuggestions.get(word) ?? [])
            .filter((suggestion, suggestionIndex, all) => (
              suggestion.word !== word
              && isPlausibleEnglishWord(suggestion.word)
              && all.findIndex((candidate) => candidate.word === suggestion.word) === suggestionIndex
            ))
            .slice(0, 3)
          const needsReview = !existingWords.has(word) && suggestions.length > 0
          const meaningReview = meaningReviewForWord(
            word,
            pastedMeanings.get(word),
            definitionResult.definitions.get(word),
            crossSwappedWords.has(word),
          )
          const needsMeaningReview = meaningStateNeedsReview(meaningReview.meaningState)

          return {
            id: makeReviewId(index),
            word,
            originalWord: word,
            selected: !existingWords.has(word) && !needsReview && !needsMeaningReview,
            repeatedInPhoto: repeated.has(word),
            recovered: false,
            requiresManualValidation: false,
            suggestions,
            reviewState: needsReview ? 'pending' : 'clear',
            meaningEditedByUser: false,
            ...meaningReview,
          }
        }),
      )
      setLiveMessage(`붙여넣은 텍스트에서 영어 단어 ${reviewWords.length}개를 찾았어요.`)
      notify(
        `붙여넣은 텍스트에서 영어 단어 ${reviewWords.length}개${pastedMeanings.size > 0 ? `와 뜻 ${pastedMeanings.size}개` : ''}를 찾았어요.${parsed.truncated ? ' 너무 긴 내용은 앞부분 500개 후보까지만 분석했어요.' : ''}`,
        'success',
      )
    } catch (textError) {
      setError(textError instanceof Error ? textError.message : '텍스트를 분석하지 못했어요.')
    } finally {
      setProcessing(false)
    }
  }

  const statusFor = (item: ReviewItem) => {
    const normalized = normalizeEnglishWord(item.word)
    if (item.requiresManualValidation || !isPlausibleEnglishWord(normalized)) return 'invalid' as const
    if (existingWords.has(normalized)) return 'existing' as const
    const sameWord = reviewItems.filter(
      (candidate) => normalizeEnglishWord(candidate.word) === normalized,
    )
    if (sameWord.length > 1 && sameWord[0].id !== item.id) return 'review-duplicate' as const
    return 'new' as const
  }

  const newItems = reviewItems.filter((item) => statusFor(item) === 'new')
  const regularAvailableItems = newItems.filter((item) => !isLowConfidenceReviewItem(item))
  const lowConfidenceItems = newItems.filter(isLowConfidenceReviewItem)
  const availableItems = [...regularAvailableItems, ...lowConfidenceItems]
  const existingItems = reviewItems.filter((item) => statusFor(item) === 'existing')
  const problemItems = reviewItems.filter((item) => {
    const status = statusFor(item)
    return status === 'invalid' || status === 'review-duplicate'
  })
  const selectedCount = availableItems.filter((item) => item.selected).length
  const pendingCount = availableItems.filter(
    (item) => item.reviewState === 'pending' || meaningNeedsReview(item),
  ).length
  const attentionCount = pendingCount + problemItems.length
  const recoveredItemCount = reviewItems.filter((item) => item.recovered).length
  const repeatedItemCount = reviewItems.filter((item) => item.repeatedInPhoto).length
  const bulkSelectableItems = regularAvailableItems.filter(
    (item) => item.reviewState !== 'pending' && !meaningNeedsReview(item),
  )
  const allAvailableSelected =
    bulkSelectableItems.length > 0 && bulkSelectableItems.every((item) => item.selected)

  const updateWord = (id: string, value: string) => {
    wordRevisionRef.current.set(id, (wordRevisionRef.current.get(id) ?? 0) + 1)
    setReviewItems((current) =>
      current.map((item) => {
        if (item.id !== id) return item
        const previousStatus = statusFor(item)
        const needsValidation = item.requiresManualValidation
          || previousStatus === 'invalid'
          || previousStatus === 'review-duplicate'
          || !isPlausibleEnglishWord(normalizeEnglishWord(value))
        const normalized = normalizeEnglishWord(value)
        const revisedMeaning = meaningReviewAfterWordChange(
          item,
          normalized,
          dictionaryDefinitionsRef.current.get(normalized),
        )

        return {
          ...item,
          word: value,
          selected: !needsValidation && !meaningStateNeedsReview(revisedMeaning.meaningState),
          suggestions: [],
          requiresManualValidation: needsValidation,
          reviewState: needsValidation ? 'pending' : 'edited',
          ...revisedMeaning,
        }
      }),
    )
    setLiveMessage('수정한 철자를 확인해 주세요.')
  }

  const confirmEditedCandidate = async (id: string) => {
    const item = reviewItems.find((candidate) => candidate.id === id)
    const normalized = normalizeEnglishWord(item?.word ?? '')
    if (!item || !isPlausibleEnglishWord(normalized)) {
      setLiveMessage('저장할 수 있는 영어 단어 형태로 수정해 주세요.')
      return
    }
    const requestedRevision = wordRevisionRef.current.get(id) ?? 0

    let dictionary = dictionaryDefinitionsRef.current.get(normalized)
    if (!dictionary) {
      const result = await lookupKoreanDefinitions([normalized])
      dictionary = result.definitions.get(normalized)
      if (dictionary) dictionaryDefinitionsRef.current.set(normalized, dictionary)
    }
    if ((wordRevisionRef.current.get(id) ?? 0) !== requestedRevision) {
      setLiveMessage('단어가 다시 수정되어 최신 철자를 기준으로 확인해 주세요.')
      return
    }

    setReviewItems((current) => current.map((candidate) => {
      if (candidate.id !== id || normalizeEnglishWord(candidate.word) !== normalized) {
        return candidate
      }
      const currentMeaningReview = meaningReviewAfterWordChange(
        candidate,
        normalized,
        dictionary,
      )
      return {
        ...candidate,
        ...currentMeaningReview,
        requiresManualValidation: false,
        reviewState: 'edited',
        selected: !meaningStateNeedsReview(currentMeaningReview.meaningState),
      }
    }))
    const meaningReview = meaningReviewAfterWordChange(item, normalized, dictionary)
    setLiveMessage(
      meaningStateNeedsReview(meaningReview.meaningState)
        ? '철자를 확인했어요. 한국어 뜻도 확인해 주세요.'
        : '직접 수정한 단어를 확인하고 선택했어요.',
    )
  }

  const toggleWord = (id: string) => {
    setReviewItems((current) =>
      current.map((item) =>
        item.id === id
          && statusFor(item) === 'new'
          && item.reviewState !== 'pending'
          && !meaningNeedsReview(item)
          ? { ...item, selected: !item.selected }
          : item,
      ),
    )
  }

  const toggleAll = () => {
    setReviewItems((current) =>
      current.map((item) =>
        statusFor(item) === 'new'
          && item.reviewState !== 'pending'
          && !meaningNeedsReview(item)
          ? { ...item, selected: !allAvailableSelected }
          : item,
      ),
    )
  }

  const applySuggestion = (id: string, suggestion: string) => {
    const normalized = normalizeEnglishWord(suggestion)
    const validSuggestion = isPlausibleEnglishWord(normalized)
    const currentItem = reviewItems.find((item) => item.id === id)
    const revisedMeaning = currentItem
      ? meaningReviewAfterWordChange(
          currentItem,
          normalized,
          dictionaryDefinitionsRef.current.get(normalized),
        )
      : null
    wordRevisionRef.current.set(id, (wordRevisionRef.current.get(id) ?? 0) + 1)
    setReviewItems((current) => current.map((item) => {
      if (item.id !== id) return item
      const meaningReview = revisedMeaning ?? meaningReviewAfterWordChange(
        item,
        normalized,
        dictionaryDefinitionsRef.current.get(normalized),
      )
      return {
        ...item,
        word: suggestion,
        selected: validSuggestion && !meaningStateNeedsReview(meaningReview.meaningState),
        suggestions: [],
        requiresManualValidation: !validSuggestion,
        reviewState: validSuggestion ? 'corrected' : 'pending',
        ...meaningReview,
      }
    }))
    setLiveMessage(
      validSuggestion && revisedMeaning && meaningStateNeedsReview(revisedMeaning.meaningState)
        ? `${suggestion}으로 교정했어요. 한국어 뜻도 확인해 주세요.`
        : validSuggestion
          ? `${suggestion}으로 교정하고 선택했어요.`
        : '추천 결과를 저장할 수 있는 영어 단어 형태로 다시 확인해 주세요.',
    )
  }

  const keepOriginalWord = (id: string) => {
    const currentItem = reviewItems.find((item) => item.id === id)
    setReviewItems((current) => current.map((item) => (
      item.id === id
        ? {
            ...item,
            selected: !meaningNeedsReview(item),
            suggestions: [],
            requiresManualValidation: false,
            reviewState: 'kept',
          }
        : item
    )))
    setLiveMessage(
      currentItem && meaningNeedsReview(currentItem)
        ? '인식된 영문을 유지했어요. 한국어 뜻도 확인해 주세요.'
        : '인식된 원문을 그대로 유지하고 선택했어요.',
    )
  }

  const updateMeaning = (id: string, value: string) => {
    setReviewItems((current) => current.map((item) => (
      item.id === id
        ? {
            ...item,
            meaning: value,
            meaningEditedByUser: Boolean(value.trim()),
            meaningSpacingCorrected: false,
            selected: value.trim()
              ? (meaningNeedsReview(item) ? item.reviewState !== 'pending' : item.selected)
              : item.selected,
            meaningState: value.trim() ? 'edited' : 'empty',
          }
        : item
    )))
    setLiveMessage('한국어 뜻을 직접 확인했어요.')
  }

  const confirmPhotographedMeaning = (id: string) => {
    setReviewItems((current) => current.map((item) => (
      item.id === id
        ? {
            ...item,
            selected: item.reviewState !== 'pending',
            meaningState: 'confirmed',
          }
        : item
    )))
    setLiveMessage('사진에서 읽은 뜻을 사용할게요.')
  }

  const chooseDictionaryMeaning = (id: string) => {
    setReviewItems((current) => current.map((item) => (
      item.id === id && item.dictionaryMeaning
        ? {
            ...item,
            meaning: item.dictionaryMeaning,
            partOfSpeech: item.dictionaryPartOfSpeech || item.partOfSpeech,
            meaningEditedByUser: false,
            meaningSpacingCorrected: false,
            selected: item.reviewState !== 'pending',
            meaningState: 'dictionary',
          }
        : item
    )))
    setLiveMessage('내장 사전 뜻을 사용할게요.')
  }

  const removeReviewItem = (id: string) => {
    wordRevisionRef.current.delete(id)
    setReviewItems((current) => current.filter((item) => item.id !== id))
  }

  const saveSelected = async () => {
    const selected = reviewItems
      .filter((item) => item.selected && statusFor(item) === 'new')
      .map((item) => ({
        word: normalizeEnglishWord(item.word),
        meaning: item.meaning.trim(),
        partOfSpeech: item.partOfSpeech.trim(),
      }))
    if (selected.length === 0) return

    setSaving(true)
    try {
      const enriched = await enrichWithKoreanDefinitions(selected)
      const result = await addMany(enriched.entries)
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
          <ArrowLeft size={18} aria-hidden="true" /> {sourceMode === 'text' ? '다른 텍스트 입력' : '다른 사진 선택'}
        </button>
        <div className="page-heading review-heading">
          <div>
            <span className="eyebrow">CHECK BEFORE SAVE</span>
            <h1 id="review-title">인식 결과를 확인해 주세요</h1>
            <p>영문 철자와 연결된 한국어 뜻을 확인한 뒤 저장해 주세요.</p>
          </div>
          <div className="review-count-pill">
            <strong>{selectedCount}</strong>
            <span>개 선택됨</span>
          </div>
        </div>
        <p className="sr-only" aria-live="polite">{liveMessage}</p>

        <div className="review-layout">
          <aside className="review-preview surface">
            {sourceMode === 'text' ? (
              <div className="review-text-wrap">
                <span>붙여넣은 원문</span>
                <pre>{rawText}</pre>
              </div>
            ) : (
              <div className="review-image-wrap">
                <img src={previewUrl} alt="한국어와 영어가 포함된 사진 미리보기" />
              </div>
            )}
            {recognitionSummary ? (
              <div className="recognition-summary" aria-label="인식 요약">
                {recognitionSummary.numberedVocabularyDetected ? (
                  <span>번호형 단어장 · 표제어 {recognitionSummary.layoutEntryCount}개</span>
                ) : (
                  <span>{recognitionSummary.detectedKorean ? '한·영 혼합 인식' : '영어 인식'}</span>
                )}
                <span>전체 신뢰도 {Math.round(recognitionSummary.confidence)}%</span>
                <span>{recognitionSummary.passCount}회 비교</span>
                {recognitionSummary.excludedCandidateCount > 0 ? (
                  <span>본문·파생어 후보 {recognitionSummary.excludedCandidateCount}개 제외</span>
                ) : null}
                {recognitionSummary.hiddenLowConfidenceCount > 0 ? (
                  <span>20% 미만 {recognitionSummary.hiddenLowConfidenceCount}개 제외</span>
                ) : null}
              </div>
            ) : null}
            {sourceMode === 'photo' ? (
              <>
                <button type="button" className="text-button raw-toggle" onClick={() => setShowRawText((value) => !value)} aria-expanded={showRawText}>
                  <ScanText size={17} aria-hidden="true" /> {showRawText ? '인식 문장 접기' : '인식 문장 보기'}
                </button>
                {showRawText ? <pre className="raw-text">{rawText}</pre> : null}
              </>
            ) : null}
            <div className="privacy-note compact">
              <LockKeyhole size={16} aria-hidden="true" />
              <span>{sourceMode === 'text' ? '붙여넣은 텍스트는 이 기기 밖으로 전송되지 않아요.' : '사진과 인식 결과는 이 기기 밖으로 전송되지 않아요.'}</span>
            </div>
          </aside>

          <div className="review-panel surface">
            <div className="review-toolbar">
              <div>
                <h2>인식된 영어 단어와 뜻</h2>
                <p>고유 후보 {reviewItems.length}개 · 저장 가능 {availableItems.length}개 · 확인 필요 {attentionCount}개</p>
                {recoveredItemCount > 0 || repeatedItemCount > 0 ? (
                  <p className="review-detail-counts">
                    {recoveredItemCount > 0 ? `추가 회수 ${recoveredItemCount}개` : null}
                    {recoveredItemCount > 0 && repeatedItemCount > 0 ? ' · ' : null}
                    {repeatedItemCount > 0 ? `반복 출현 ${repeatedItemCount}개는 한 번씩 표시` : null}
                  </p>
                ) : null}
              </div>
              <button type="button" className="button button-quiet compact-button" onClick={toggleAll} disabled={bulkSelectableItems.length === 0}>
                {allAvailableSelected ? <X size={16} aria-hidden="true" /> : <CheckCheck size={16} aria-hidden="true" />}
                {allAvailableSelected ? '확인된 단어 해제' : '확인된 단어 선택'}
              </button>
            </div>

            <div className="review-word-list">
              {availableItems.map((item, index) => (
                <Fragment key={item.id}>
                  {lowConfidenceItems.length > 0 && index === regularAvailableItems.length ? (
                    <div className="low-confidence-divider" role="note">
                      <strong>낮은 인식률 후보 · 별도 검토</strong>
                      <span>40~49%는 철자를 확인해 주세요. 20~39%는 오류 가능성이 매우 높아요.</span>
                    </div>
                  ) : null}
                  <div
                    className={`review-word-item ${item.selected ? 'is-selected' : ''} ${item.reviewState === 'pending' || meaningNeedsReview(item) ? 'needs-review' : ''} ${isVeryLowConfidenceItem(item) ? 'very-low-confidence' : ''}`}
                  >
                  <div className="review-word-row">
                    <label className="review-checkbox">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        disabled={item.reviewState === 'pending' || meaningNeedsReview(item)}
                        onChange={() => toggleWord(item.id)}
                      />
                      <span className="custom-check"><Check size={14} aria-hidden="true" /></span>
                      <span className="sr-only">{item.word} 선택</span>
                    </label>
                    <div className="editable-word">
                      <Pencil size={15} aria-hidden="true" />
                      <input
                        value={item.word}
                        onChange={(event) => updateWord(item.id, event.target.value)}
                        aria-label={`${item.originalWord} 단어 수정`}
                        aria-describedby={item.reviewState === 'pending' ? `correction-help-${item.id}` : undefined}
                        lang="en"
                        spellCheck={false}
                      />
                    </div>
                    {item.confidence !== undefined ? (
                      <span className={`confidence-badge ${item.confidence < LOW_CONFIDENCE_THRESHOLD ? 'is-low' : ''} ${isVeryLowConfidenceItem(item) ? 'is-critical' : ''}`}>
                        {Math.round(item.confidence)}%
                      </span>
                    ) : null}
                    {item.recovered ? <span className="mini-badge recovered-badge">추가 발견</span> : null}
                    {item.repeatedInPhoto ? <span className="mini-badge">여러 번 발견</span> : null}
                    <button type="button" className="icon-button danger" onClick={() => removeReviewItem(item.id)} aria-label={`${item.word} 결과에서 삭제`}>
                      <Trash2 size={17} aria-hidden="true" />
                    </button>
                  </div>
                  {item.reviewState === 'pending' ? (
                    <div className="correction-panel" role="group" aria-label={`${item.originalWord} 교정`}>
                      <div id={`correction-help-${item.id}`} className="correction-copy">
                        <strong>
                          {isVeryLowConfidenceItem(item)
                            ? '인식률이 매우 낮아요.'
                            : isLowConfidenceReviewItem(item)
                              ? '별도 검토가 필요한 후보예요.'
                              : item.recovered
                                ? '다른 인식 결과에서 추가로 발견했어요.'
                                : '인식이 불확실해요.'}
                        </strong>
                        <span>
                          {isLowConfidenceReviewItem(item)
                            ? '철자를 직접 확인해야 저장할 수 있어요.'
                            : '추천 단어를 누르거나 원문을 확인해 주세요.'}
                        </span>
                      </div>
                      <div className="correction-suggestions">
                        {item.suggestions.map((suggestion) => (
                          <button
                            type="button"
                            className="correction-button suggestion"
                            key={suggestion.word}
                            onClick={() => applySuggestion(item.id, suggestion.word)}
                            aria-label={`${item.originalWord}를 ${suggestion.word}로 수정`}
                          >
                            혹시 <span lang="en">{suggestion.word}</span>?
                          </button>
                        ))}
                        <button type="button" className="correction-button" onClick={() => keepOriginalWord(item.id)}>
                          원문 유지
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div className={`review-meaning meaning-${item.meaningState}`}>
                    <div className="review-meaning-heading">
                      <label htmlFor={`meaning-${item.id}`}>한국어 뜻</label>
                      <span className="meaning-status">{meaningStateLabel(item)}</span>
                      {item.partOfSpeech ? <span className="pos-chip">{item.partOfSpeech}</span> : null}
                      {item.meaningCandidate ? (
                        <span className="meaning-confidence">
                          {sourceMode === 'text' ? '텍스트에서 찾은 뜻' : `사진 인식 ${Math.round(item.meaningCandidate.confidence)}%`}
                        </span>
                      ) : null}
                    </div>
                    <input
                      id={`meaning-${item.id}`}
                      className="review-meaning-input"
                      value={item.meaning}
                      onChange={(event) => updateMeaning(item.id, event.target.value)}
                      placeholder="뜻을 찾지 못했어요. 직접 입력할 수 있어요."
                      aria-label={`${normalizeEnglishWord(item.word) || item.word} 한국어 뜻`}
                      aria-describedby={meaningNeedsReview(item) ? `meaning-help-${item.id}` : undefined}
                    />
                    {meaningNeedsReview(item) ? (
                      <div id={`meaning-help-${item.id}`} className="meaning-check-panel">
                        <div>
                          <strong>가져온 뜻을 한 번 확인해 주세요.</strong>
                          <span>내장 사전과 정확히 일치하지 않거나 사전에 없는 표현이에요.</span>
                        </div>
                        {item.dictionaryMeaning ? (
                          <p><strong>내장 사전</strong><span>{item.dictionaryMeaning}</span></p>
                        ) : null}
                        <div className="meaning-check-actions">
                          <button
                            type="button"
                            className="correction-button"
                            onClick={() => confirmPhotographedMeaning(item.id)}
                            aria-label={`${item.word}의 ${item.meaningEditedByUser ? '현재' : sourceMode === 'text' ? '붙여넣은' : '사진 속'} 한국어 뜻 사용`}
                          >
                            {item.meaningEditedByUser ? '현재 뜻 사용' : sourceMode === 'text' ? '붙여넣은 뜻 사용' : '사진 뜻 사용'}
                          </button>
                          {item.dictionaryMeaning ? (
                            <button
                              type="button"
                              className="correction-button suggestion"
                              onClick={() => chooseDictionaryMeaning(item.id)}
                              aria-label={`${item.word}의 내장 사전 뜻 사용`}
                            >
                              내장 사전 뜻 사용
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  </div>
                </Fragment>
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
              <details className="duplicate-section warning-section" open>
                <summary>추가 확인이 필요한 후보 <span>{problemItems.length}</span></summary>
                <div className="review-word-list problem-list">
                  {problemItems.map((item) => (
                    <div className="review-word-row" key={item.id}>
                      <div className="editable-word">
                        <Pencil size={15} aria-hidden="true" />
                        <input value={item.word} onChange={(event) => updateWord(item.id, event.target.value)} aria-label={`${item.originalWord} 단어 수정`} lang="en" spellCheck={false} />
                      </div>
                      {item.suggestions.map((suggestion) => (
                        <button
                          type="button"
                          className="correction-button suggestion confirm-edit-button"
                          key={suggestion.word}
                          onClick={() => applySuggestion(item.id, suggestion.word)}
                          aria-label={`${item.originalWord}를 ${suggestion.word}로 수정`}
                        >
                          혹시 <span lang="en">{suggestion.word}</span>?
                        </button>
                      ))}
                      {item.confidence !== undefined ? (
                        <span className="confidence-badge is-low">{Math.round(item.confidence)}%</span>
                      ) : null}
                      {item.recovered ? <span className="mini-badge recovered-badge">추가 발견</span> : null}
                      <span className="validation-label">{statusFor(item) === 'invalid' ? '영문 단어 확인' : '검토 목록 중복'}</span>
                      <button
                        type="button"
                        className="correction-button confirm-edit-button"
                        disabled={!isPlausibleEnglishWord(normalizeEnglishWord(item.word))}
                        onClick={() => void confirmEditedCandidate(item.id)}
                        aria-label={`${item.originalWord} 수정 확인`}
                      >
                        수정 확인
                      </button>
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
          <h1 id="photo-title">사진과 긴 텍스트를<br /><em>오늘의 단어장</em>으로.</h1>
          <p>사진을 올리거나 긴 글을 붙여넣으면 영어 단어를 자동으로 찾고, 단어 목록에 포함된 한국어 뜻도 함께 연결해 드려요.</p>
          <div className="feature-points" aria-label="주요 특징">
            <span><Check size={15} aria-hidden="true" /> 기기 안에서만 분석</span>
            <span><Check size={15} aria-hidden="true" /> 한·영 혼합 OCR·뜻 연결</span>
            <span><Check size={15} aria-hidden="true" /> 무료·API 키 불필요</span>
          </div>
        </div>

        <div className="upload-card surface">
          <div className="upload-card-header">
            <div className="step-badge">01</div>
            <div>
              <h2>{sourceMode === 'photo' ? '한국어와 영어가 보이는 사진을 올려 주세요' : '긴 텍스트를 붙여넣어 주세요'}</h2>
              <p>{sourceMode === 'photo' ? 'JPG, PNG, WebP, BMP, GIF · 최대 15MB' : '영문 문장 또는 apple - 사과 형식의 단어 목록'}</p>
            </div>
          </div>

          <div className="source-mode-tabs" role="tablist" aria-label="단어 입력 방식">
            <button type="button" role="tab" aria-selected={sourceMode === 'photo'} className={sourceMode === 'photo' ? 'is-active' : ''} onClick={() => switchSourceMode('photo')}>
              <Camera size={16} aria-hidden="true" /> 사진
            </button>
            <button type="button" role="tab" aria-selected={sourceMode === 'text'} className={sourceMode === 'text' ? 'is-active' : ''} onClick={() => switchSourceMode('text')}>
              <ClipboardPaste size={16} aria-hidden="true" /> 텍스트 붙여넣기
            </button>
          </div>

          <input ref={uploadInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/gif" onChange={(event) => chooseFile(event.target.files?.[0])} />
          <input ref={cameraInputRef} className="sr-only" type="file" accept="image/*" capture="environment" onChange={(event) => chooseFile(event.target.files?.[0])} />

          {sourceMode === 'photo' ? (
            <>
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
                    <img src={previewUrl} alt="인식할 한국어와 영어 문장 사진 미리보기" />
                    <button type="button" className="remove-photo" onClick={resetAll} disabled={processing} aria-label="선택한 사진 제거"><X size={18} aria-hidden="true" /></button>
                  </div>
                  <div className="selected-file-info">
                    <FileImage size={20} aria-hidden="true" />
                    <div><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} MB</span></div>
                  </div>
                </div>
              )}
              {file ? (
                <label className="accuracy-toggle">
                  <input type="checkbox" checked={accurateRecognition} disabled={processing} onChange={(event) => setAccurateRecognition(event.target.checked)} />
                  <span><strong>정밀 인식</strong><small>페이지 방식과 보정을 달리해 찾은 단어 후보를 합쳐요. 조금 더 걸릴 수 있어요.</small></span>
                </label>
              ) : null}
            </>
          ) : (
            <label className="paste-text-field">
              <span>분석할 텍스트</span>
              <textarea
                value={pastedText}
                onChange={(event) => setPastedText(event.target.value)}
                placeholder={'영문 문장을 그대로 붙여넣거나\napple - 사과\nabrupt: 갑작스러운'}
                rows={12}
                maxLength={120_000}
                autoFocus
              />
              <small>{pastedText.length.toLocaleString()}자 · 고유 영어 단어 최대 500개</small>
            </label>
          )}

          {error ? <div className="error-message" role="alert"><span>!</span><p>{error}</p><button type="button" onClick={() => setError('')} aria-label="오류 메시지 닫기"><X size={15} /></button></div> : null}

          {processing ? (
            sourceMode === 'photo' ? (
              <div className="ocr-progress" aria-live="polite">
                <div className="progress-copy"><span>{progress.message}</span><strong>{progress.percent}%</strong></div>
                <progress value={progress.percent} max="100">{progress.percent}%</progress>
                <div className="progress-meta"><span>사진 전처리</span><span>한·영 인식</span><span>교정 후보 확인</span></div>
                <button type="button" className="text-button cancel-ocr" onClick={() => abortRef.current?.abort()}>인식 취소</button>
              </div>
            ) : <div className="text-analysis-progress" aria-live="polite"><span className="spinner small" aria-hidden="true" /> 텍스트를 분석하고 있어요.</div>
          ) : (
            <div className="upload-actions">
              {sourceMode === 'text' ? (
                <button type="button" className="button button-primary button-wide" disabled={!pastedText.trim()} onClick={() => void startTextRecognition()}><ClipboardPaste size={18} aria-hidden="true" /> 붙여넣은 텍스트 분석</button>
              ) : !file ? (
                <>
                  <button type="button" className="button button-primary" onClick={() => uploadInputRef.current?.click()}><ImagePlus size={18} aria-hidden="true" /> 사진 선택</button>
                  <button type="button" className="button button-secondary" onClick={() => cameraInputRef.current?.click()}><Camera size={18} aria-hidden="true" /> 카메라로 촬영</button>
                </>
              ) : (
                <>
                  <button type="button" className="button button-primary button-wide" onClick={() => void startRecognition()}><ScanText size={19} aria-hidden="true" /> 한·영 텍스트 인식 시작</button>
                  <button type="button" className="button button-quiet" onClick={() => uploadInputRef.current?.click()}><RotateCcw size={17} aria-hidden="true" /> 사진 바꾸기</button>
                </>
              )}
            </div>
          )}

          <div className="privacy-note">
            <LockKeyhole size={18} aria-hidden="true" />
            <div><strong>사진과 텍스트는 업로드되지 않아요</strong><span>사진 OCR과 붙여넣은 텍스트 분석은 이 브라우저 안에서 실행됩니다.</span></div>
          </div>
        </div>
      </div>

      <div className="how-it-works" aria-labelledby="how-title">
        <div className="section-heading"><span className="eyebrow">HOW IT WORKS</span><h2 id="how-title">세 단계면 충분해요</h2></div>
        <ol className="steps-grid">
          <li><span className="step-number">01</span><div className="step-icon"><Camera size={22} /></div><h3>사진 또는 텍스트</h3><p>사진을 고르거나 긴 글을 그대로 붙여넣습니다.</p></li>
          <li><span className="step-number">02</span><div className="step-icon"><ScanText size={22} /></div><h3>자동 단어 인식</h3><p>영어 단어와 목록에 적힌 한국어 뜻을 자동으로 찾습니다.</p></li>
          <li><span className="step-number">03</span><div className="step-icon"><BookOpenIcon /></div><h3>확인 후 저장</h3><p>필요한 단어를 고쳐 골라서 단어장에 담습니다.</p></li>
        </ol>
      </div>
    </section>
  )
}

function BookOpenIcon() {
  return <CheckCheck size={22} aria-hidden="true" />
}
