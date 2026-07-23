import type { OcrLineEvidence, OcrWordEvidence } from './ocr'
import { isPlausibleEnglishWord, normalizeEnglishWord } from './wordExtraction'

const ORDINAL_PATTERN = /^([0-9oO]{3,5})[.)]?$/u

const ENGLISH_PARTS_OF_SPEECH: Readonly<Record<string, string>> = {
  n: '명사',
  noun: '명사',
  v: '동사',
  verb: '동사',
  vi: '동사',
  vt: '동사',
  adj: '형용사',
  adjective: '형용사',
  adv: '부사',
  adverb: '부사',
  pron: '대명사',
  pronoun: '대명사',
  prep: '전치사',
  preposition: '전치사',
  conj: '접속사',
  conjunction: '접속사',
  interj: '감탄사',
  interjection: '감탄사',
  det: '한정사',
  determiner: '한정사',
  aux: '조동사',
  auxiliary: '조동사',
}

const KOREAN_PARTS_OF_SPEECH: Readonly<Record<string, string>> = {
  명: '명사',
  명사: '명사',
  동: '동사',
  동사: '동사',
  형: '형용사',
  형용사: '형용사',
  부: '부사',
  부사: '부사',
  대명사: '대명사',
  전치사: '전치사',
  접속사: '접속사',
  감탄사: '감탄사',
  관사: '관사',
  조동사: '조동사',
  한정사: '한정사',
}

interface PositionedWord {
  evidence: OcrWordEvidence
  line: OcrLineEvidence
}

interface VocabularyAnchor {
  number: string
  numericNumber: number
  numberEvidence: OcrWordEvidence
  word: string
  wordEvidence: OcrWordEvidence
}

interface RightColumnPoint {
  blockIndex: number
  x: number
}

interface VisualWordRow {
  evidence: OcrWordEvidence[]
}

export interface NumberedVocabularyEntry {
  number: string
  word: string
  meaning: string
  partOfSpeech: string
  /** Lowest OCR confidence among the number, headword, and captured meaning. */
  confidence: number
  numberEvidence: OcrWordEvidence
  wordEvidence: OcrWordEvidence
  meaningEvidence: OcrWordEvidence[]
}

export type NumberedVocabularyLayoutFailureReason =
  | 'not-enough-anchors'
  | 'inconsistent-anchor-columns'
  | 'inconsistent-number-sequence'
  | 'not-two-column-layout'
  | 'insufficient-meaning-evidence'

export type NumberedVocabularyLayoutResult =
  | {
      detected: true
      confidence: 'high'
      anchorCount: number
      rightColumnStart: number
      entries: NumberedVocabularyEntry[]
    }
  | {
      detected: false
      reason: NumberedVocabularyLayoutFailureReason
      anchorCount: number
      entries: []
    }

function height(evidence: OcrWordEvidence): number {
  return evidence.bbox.y1 - evidence.bbox.y0
}

function centerY(evidence: OcrWordEvidence): number {
  return (evidence.bbox.y0 + evidence.bbox.y1) / 2
}

function verticalOverlapRatio(left: OcrWordEvidence, right: OcrWordEvidence): number {
  const overlap = Math.max(
    0,
    Math.min(left.bbox.y1, right.bbox.y1) - Math.max(left.bbox.y0, right.bbox.y0),
  )
  return overlap / Math.max(1, Math.min(height(left), height(right)))
}

function visualRowCenter(row: VisualWordRow): number {
  return median(row.evidence.map(centerY))
}

function visualRowHeight(row: VisualWordRow): number {
  return median(row.evidence.map(height))
}

function evidenceBelongsToVisualRow(
  evidence: OcrWordEvidence,
  row: VisualWordRow,
  centerTolerance: number,
): boolean {
  const overlapsExistingWord = row.evidence.some(
    (existing) => verticalOverlapRatio(existing, evidence) >= 0.45,
  )
  const allowedCenterDistance = Math.max(
    3,
    centerTolerance,
    Math.min(height(evidence), visualRowHeight(row)) * 0.4,
  )
  return overlapsExistingWord
    || Math.abs(centerY(evidence) - visualRowCenter(row)) <= allowedCenterDistance
}

function groupEvidenceIntoVisualRows(
  evidence: readonly OcrWordEvidence[],
  centerTolerance: number,
): VisualWordRow[] {
  const rows: VisualWordRow[] = []
  const sorted = [...evidence].sort((left, right) => (
    centerY(left) - centerY(right) || left.bbox.x0 - right.bbox.x0
  ))

  for (const item of sorted) {
    const matchingRow = rows.find((row) => (
      evidenceBelongsToVisualRow(item, row, centerTolerance)
    ))
    if (matchingRow) matchingRow.evidence.push(item)
    else rows.push({ evidence: [item] })
  }

  return rows
    .map((row) => ({
      evidence: [...row.evidence].sort((left, right) => left.bbox.x0 - right.bbox.x0),
    }))
    .sort((left, right) => visualRowCenter(left) - visualRowCenter(right))
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function ordinalFromEvidence(evidence: OcrWordEvidence): { text: string, value: number } | null {
  const match = evidence.text.normalize('NFKC').trim().match(ORDINAL_PATTERN)
  if (!match || !/\d/u.test(match[1])) return null
  const normalized = match[1].replace(/[oO]/gu, '0')
  return { text: normalized, value: Number.parseInt(normalized, 10) }
}

function partOfSpeechFromEvidence(evidence: OcrWordEvidence): string {
  const normalizedEnglish = evidence.text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z]/gu, '')
  const englishPart = ENGLISH_PARTS_OF_SPEECH[normalizedEnglish]
  if (englishPart) return englishPart

  const normalizedKorean = evidence.text.normalize('NFKC').replace(/[^가-힣]/gu, '')
  return KOREAN_PARTS_OF_SPEECH[normalizedKorean] ?? ''
}

function headwordFromEvidence(evidence: OcrWordEvidence): string {
  if (/[가-힣\d]/u.test(evidence.text) || partOfSpeechFromEvidence(evidence)) return ''
  const word = normalizeEnglishWord(evidence.text)
  return word && isPlausibleEnglishWord(word) ? word : ''
}

function flattenWords(lines: readonly OcrLineEvidence[]): PositionedWord[] {
  return lines.flatMap((line) => line.words.map((evidence) => ({ evidence, line })))
}

function findAnchors(words: readonly PositionedWord[]): VocabularyAnchor[] {
  const anchors: VocabularyAnchor[] = []

  for (const positionedNumber of words) {
    const ordinal = ordinalFromEvidence(positionedNumber.evidence)
    if (!ordinal) continue
    const numberEvidence = positionedNumber.evidence
    const numberHeight = Math.max(1, height(numberEvidence))

    const headword = words
      .map(({ evidence }) => ({ evidence, word: headwordFromEvidence(evidence) }))
      .filter(({ evidence, word }) => (
        Boolean(word)
        && evidence !== numberEvidence
        && evidence.bbox.x0 >= numberEvidence.bbox.x1 - numberHeight * 0.15
        && evidence.bbox.x0 - numberEvidence.bbox.x1 <= numberHeight * 7
        && (
          verticalOverlapRatio(numberEvidence, evidence) >= 0.45
          || Math.abs(centerY(numberEvidence) - centerY(evidence))
            <= Math.max(numberHeight, height(evidence)) * 0.55
        )
      ))
      .sort((left, right) => left.evidence.bbox.x0 - right.evidence.bbox.x0)[0]

    if (!headword) continue
    anchors.push({
      number: ordinal.text,
      numericNumber: ordinal.value,
      numberEvidence,
      word: headword.word,
      wordEvidence: headword.evidence,
    })
  }

  return anchors.sort((left, right) => (
    centerY(left.numberEvidence) - centerY(right.numberEvidence)
    || left.numericNumber - right.numericNumber
  ))
}

function withinTolerance(values: readonly number[], tolerance: number): boolean {
  const midpoint = median(values)
  return values.every((value) => Math.abs(value - midpoint) <= tolerance)
}

function anchorsHaveConsistentGeometry(anchors: readonly VocabularyAnchor[]): boolean {
  const typicalHeadwordHeight = median(anchors.map((anchor) => height(anchor.wordEvidence)))
  const typicalNumberHeight = median(anchors.map((anchor) => height(anchor.numberEvidence)))
  if (typicalHeadwordHeight < typicalNumberHeight * 1.08) return false

  const numberX = anchors.map((anchor) => anchor.numberEvidence.bbox.x0)
  const headwordX = anchors.map((anchor) => anchor.wordEvidence.bbox.x0)
  if (
    !withinTolerance(numberX, typicalHeadwordHeight * 1.35)
    || !withinTolerance(headwordX, typicalHeadwordHeight * 1.75)
  ) return false

  const gaps = anchors.slice(1).map((anchor, index) => (
    centerY(anchor.numberEvidence) - centerY(anchors[index].numberEvidence)
  ))
  return gaps.every((gap) => gap > typicalHeadwordHeight * 1.8)
    && median(gaps) >= typicalHeadwordHeight * 2.5
}

function anchorsHaveIncreasingNumbers(anchors: readonly VocabularyAnchor[]): boolean {
  return anchors.slice(1).every((anchor, index) => (
    anchor.numericNumber > anchors[index].numericNumber
    && anchor.numericNumber - anchors[index].numericNumber <= 20
  ))
}

function blockIndexForY(
  y: number,
  anchors: readonly VocabularyAnchor[],
  typicalBlockHeight: number,
): number {
  for (let index = 0; index < anchors.length; index += 1) {
    const start = Math.min(
      anchors[index].numberEvidence.bbox.y0,
      anchors[index].wordEvidence.bbox.y0,
    )
    const end = index + 1 < anchors.length
      ? Math.min(
          anchors[index + 1].numberEvidence.bbox.y0,
          anchors[index + 1].wordEvidence.bbox.y0,
        )
      : start + typicalBlockHeight
    if (y >= start && y < end) return index
  }
  return -1
}

function findRightColumnStart(
  words: readonly PositionedWord[],
  anchors: readonly VocabularyAnchor[],
): number | null {
  const typicalHeadwordHeight = median(anchors.map((anchor) => height(anchor.wordEvidence)))
  const typicalHeadwordX = median(anchors.map((anchor) => anchor.wordEvidence.bbox.x0))
  const anchorGaps = anchors.slice(1).map((anchor, index) => (
    centerY(anchor.numberEvidence) - centerY(anchors[index].numberEvidence)
  ))
  const typicalBlockHeight = median(anchorGaps)
  const minimumRightX = typicalHeadwordX + typicalHeadwordHeight * 6
  const points: RightColumnPoint[] = []

  const visualRows = groupEvidenceIntoVisualRows(
    words.map(({ evidence }) => evidence),
    typicalHeadwordHeight * 0.35,
  )
  for (const row of visualRows) {
    const firstRightEvidence = row.evidence.find((evidence) => evidence.bbox.x0 >= minimumRightX)
    if (!firstRightEvidence) continue
    const blockIndex = blockIndexForY(visualRowCenter(row), anchors, typicalBlockHeight)
    if (blockIndex >= 0) {
      points.push({ blockIndex, x: firstRightEvidence.bbox.x0 })
    }
  }

  const tolerance = Math.max(4, typicalHeadwordHeight * 0.6)
  const clusters: RightColumnPoint[][] = []
  for (const point of [...points].sort((left, right) => left.x - right.x)) {
    const matching = clusters.find((cluster) => (
      Math.abs(point.x - median(cluster.map((item) => item.x))) <= tolerance
    ))
    if (matching) matching.push(point)
    else clusters.push([point])
  }

  const requiredBlocks = Math.max(2, Math.ceil(anchors.length * 0.6))
  const candidates = clusters
    .map((cluster) => ({
      blockCount: new Set(cluster.map((point) => point.blockIndex)).size,
      // Use the low edge of the stable cluster. A median shifted to the right
      // can put a slightly left-shifted first translation token inside the
      // vocabulary column.
      x: Math.min(...cluster.map((point) => point.x)),
    }))
    .filter((cluster) => cluster.blockCount >= requiredBlocks)
    .sort((left, right) => left.x - right.x || right.blockCount - left.blockCount)

  return candidates[0]?.x ?? null
}

function koreanFragment(evidence: OcrWordEvidence): string {
  if (!/[가-힣]/u.test(evidence.text) || partOfSpeechFromEvidence(evidence)) return ''
  return evidence.text
    .normalize('NFKC')
    .replace(/[^가-힣\s,，;/·~～-]/gu, ' ')
    .replace(/，/gu, ',')
    .replace(/～/gu, '~')
    .replace(/\s+/gu, ' ')
    .trim()
}

function joinMeaningFragments(evidence: readonly OcrWordEvidence[]): string {
  return evidence
    .map(koreanFragment)
    .filter(Boolean)
    .join(' ')
    .replace(/\s*([,;/·])\s*/gu, '$1 ')
    .replace(/\s+/gu, ' ')
    .replace(/[\s,;/·-]+$/gu, '')
    .trim()
}

function createEntries(
  words: readonly PositionedWord[],
  anchors: readonly VocabularyAnchor[],
  rightColumnStart: number,
): NumberedVocabularyEntry[] {
  const typicalHeadwordHeight = median(anchors.map((anchor) => height(anchor.wordEvidence)))
  const typicalHeadwordX = median(anchors.map((anchor) => anchor.wordEvidence.bbox.x0))
  const anchorGaps = anchors.slice(1).map((anchor, index) => (
    centerY(anchor.numberEvidence) - centerY(anchors[index].numberEvidence)
  ))
  const typicalBlockHeight = median(anchorGaps)

  return anchors.map((anchor, index) => {
    const blockStart = Math.max(anchor.numberEvidence.bbox.y1, anchor.wordEvidence.bbox.y1)
    const blockEnd = index + 1 < anchors.length
      ? Math.min(
          anchors[index + 1].numberEvidence.bbox.y0,
          anchors[index + 1].wordEvidence.bbox.y0,
        )
      : Math.min(blockStart + typicalBlockHeight * 0.9, blockStart + typicalBlockHeight)

    const unsortedLeftBlockEvidence = words
      .map(({ evidence }) => evidence)
      .filter((evidence) => (
        evidence !== anchor.numberEvidence
        && evidence !== anchor.wordEvidence
        && centerY(evidence) > blockStart
        && centerY(evidence) < blockEnd
        && evidence.bbox.x0 >= typicalHeadwordX - typicalHeadwordHeight * 1.5
        && evidence.bbox.x0 < rightColumnStart - typicalHeadwordHeight * 0.35
      ))
    const leftBlockEvidence = groupEvidenceIntoVisualRows(
      unsortedLeftBlockEvidence,
      typicalHeadwordHeight * 0.35,
    ).flatMap((row) => row.evidence)

    const partOfSpeech = [...new Set(
      leftBlockEvidence.map(partOfSpeechFromEvidence).filter(Boolean),
    )].slice(0, 2).join('·')
    const meaningEvidence = leftBlockEvidence.filter((evidence) => Boolean(koreanFragment(evidence)))
    const meaning = joinMeaningFragments(meaningEvidence)
    const confidenceEvidence = [
      anchor.numberEvidence,
      anchor.wordEvidence,
      ...meaningEvidence,
    ]

    return {
      number: anchor.number,
      word: anchor.word,
      meaning,
      partOfSpeech,
      confidence: Math.min(...confidenceEvidence.map((evidence) => evidence.confidence)),
      numberEvidence: anchor.numberEvidence,
      wordEvidence: anchor.wordEvidence,
      meaningEvidence,
    }
  })
}

/**
 * Detects a numbered, two-column vocabulary-book page from selected-pass OCR boxes.
 * A high-confidence result requires at least three aligned, increasing
 * `0001 + large headword` anchors and a repeated right-column boundary.
 */
export function parseNumberedTwoColumnVocabulary(
  lines: readonly OcrLineEvidence[],
): NumberedVocabularyLayoutResult {
  const words = flattenWords(lines)
  const anchors = findAnchors(words)

  if (anchors.length < 3) {
    return { detected: false, reason: 'not-enough-anchors', anchorCount: anchors.length, entries: [] }
  }
  if (!anchorsHaveConsistentGeometry(anchors)) {
    return {
      detected: false,
      reason: 'inconsistent-anchor-columns',
      anchorCount: anchors.length,
      entries: [],
    }
  }
  if (!anchorsHaveIncreasingNumbers(anchors)) {
    return {
      detected: false,
      reason: 'inconsistent-number-sequence',
      anchorCount: anchors.length,
      entries: [],
    }
  }

  const rightColumnStart = findRightColumnStart(words, anchors)
  if (rightColumnStart === null) {
    return {
      detected: false,
      reason: 'not-two-column-layout',
      anchorCount: anchors.length,
      entries: [],
    }
  }

  const entries = createEntries(words, anchors, rightColumnStart)
  const requiredMeanings = Math.max(2, Math.ceil(anchors.length * 0.6))
  const meaningCount = entries.filter((entry) => entry.meaning.trim()).length
  if (meaningCount < requiredMeanings) {
    return {
      detected: false,
      reason: 'insufficient-meaning-evidence',
      anchorCount: anchors.length,
      entries: [],
    }
  }

  return {
    detected: true,
    confidence: 'high',
    anchorCount: anchors.length,
    rightColumnStart,
    entries,
  }
}
