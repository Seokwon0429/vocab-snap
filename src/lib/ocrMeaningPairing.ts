import type { KoreanDictionaryEntry } from './koreanDictionary'
import type { OcrLineEvidence, OcrWordEvidence } from './ocr'
import {
  extractEnglishOcrCandidates,
  isPlausibleEnglishWord,
  normalizeEnglishWord,
} from './wordExtraction'

export type OcrMeaningAgreement = 'exact' | 'related' | 'uncertain'

export interface OcrMeaningCandidate {
  word: string
  meaning: string
  partOfSpeech: string
  /** Lowest relevant OCR confidence across the English word, Korean meaning, and line. */
  confidence: number
  layoutConfidence: 'strong' | 'single'
}

interface ParsedLinePair {
  direction: 'english-first' | 'korean-first'
  hasSeparator: boolean
  wordEvidence: OcrWordEvidence
  koreanEvidence: OcrWordEvidence[]
  meaning: string
  partOfSpeech: string
  lineConfidence: number
  geometryStrong: boolean
}

const PART_OF_SPEECH_LABELS: Readonly<Record<string, string>> = {
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
}

const ENGLISH_PART_OF_SPEECH_LABELS: Readonly<Record<string, string>> = {
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
  article: '관사',
  aux: '조동사',
  auxiliary: '조동사',
  modal: '조동사',
}

const STANDALONE_PARTICLES = new Set([
  '가', '과', '는', '도', '로', '를', '만', '에', '와', '은', '을', '의', '이', '에서', '으로',
])

const GENERIC_KOREAN_TOKENS = new Set([
  '것', '등', '때', '말', '사람', '상태', '있는', '있다', '하는', '하다', '되다', '된다',
])

function hangulParts(value: string): string[] {
  return value.normalize('NFKC').match(/[가-힣]+/gu) ?? []
}

function englishWordFromEvidence(evidence: OcrWordEvidence): string {
  if (/[가-힣]/u.test(evidence.text)) return ''
  const candidates = extractEnglishOcrCandidates([evidence.text], {
    minLetters: 2,
    maxDigits: 0,
  })
  if (candidates.length !== 1 || !isPlausibleEnglishWord(candidates[0])) return ''
  return normalizeEnglishWord(candidates[0])
}

function koreanTextFromEvidence(evidence: OcrWordEvidence): string {
  if (/[A-Za-z]/u.test(evidence.text)) return ''
  return hangulParts(evidence.text).join(' ')
}

function normalizePosToken(value: string): string {
  return value.replace(/[^가-힣]/gu, '')
}

function englishPartOfSpeechFromEvidence(evidence: OcrWordEvidence): string {
  const normalized = evidence.text.normalize('NFKC').toLowerCase().replace(/[^a-z]/gu, '')
  return ENGLISH_PART_OF_SPEECH_LABELS[normalized] ?? ''
}

function meaningFromEvidence(evidence: readonly OcrWordEvidence[]) {
  const meanings: string[] = []
  const parts: string[] = []
  let weightedConfidence = 0
  let characterCount = 0

  for (const item of evidence) {
    const text = koreanTextFromEvidence(item)
    if (!text) continue
    const pos = PART_OF_SPEECH_LABELS[normalizePosToken(text)]
    if (pos) {
      if (!parts.includes(pos)) parts.push(pos)
      continue
    }

    for (const token of text.split(/\s+/u)) {
      if (!token || STANDALONE_PARTICLES.has(token)) continue
      meanings.push(token)
      weightedConfidence += item.confidence * token.length
      characterCount += token.length
    }
  }

  const meaning = meanings.join(' ').replace(/\s+/gu, ' ').trim()
  if (
    (meaning.match(/[가-힣]/gu)?.length ?? 0) < 2
    || meanings.length > 8
    || meaning.length > 80
  ) {
    return null
  }

  return {
    meaning,
    partOfSpeech: parts.slice(0, 2).join('·'),
    confidence: characterCount > 0 ? weightedConfidence / characterCount : 0,
  }
}

function effectiveLineConfidence(line: OcrLineEvidence): number {
  if (line.confidence > 0) return line.confidence
  if (line.words.length === 0) return 0
  return line.words.reduce((sum, word) => sum + word.confidence, 0) / line.words.length
}

function unionBoundingBox(evidence: readonly OcrWordEvidence[]) {
  return {
    x0: Math.min(...evidence.map((item) => item.bbox.x0)),
    y0: Math.min(...evidence.map((item) => item.bbox.y0)),
    x1: Math.max(...evidence.map((item) => item.bbox.x1)),
    y1: Math.max(...evidence.map((item) => item.bbox.y1)),
  }
}

function verticalOverlapRatio(
  left: OcrWordEvidence['bbox'],
  right: OcrWordEvidence['bbox'],
) {
  const overlap = Math.max(0, Math.min(left.y1, right.y1) - Math.max(left.y0, right.y0))
  const smallerHeight = Math.max(1, Math.min(left.y1 - left.y0, right.y1 - right.y0))
  return overlap / smallerHeight
}

function horizontalGap(
  left: OcrWordEvidence['bbox'],
  right: OcrWordEvidence['bbox'],
) {
  if (left.x1 < right.x0) return right.x0 - left.x1
  if (right.x1 < left.x0) return left.x0 - right.x1
  return 0
}

function coalesceOcrRows(lines: readonly OcrLineEvidence[]): OcrLineEvidence[] {
  const rows: OcrLineEvidence[] = []
  const sortedLines = [...lines].sort((left, right) => (
    left.bbox.y0 - right.bbox.y0 || left.bbox.x0 - right.bbox.x0
  ))

  for (const line of sortedLines) {
    const matchingRow = rows.find((row) => {
      const height = Math.max(
        row.bbox.y1 - row.bbox.y0,
        line.bbox.y1 - line.bbox.y0,
        1,
      )
      return verticalOverlapRatio(row.bbox, line.bbox) >= 0.6
        && horizontalGap(row.bbox, line.bbox) <= height * 12
    })
    if (!matchingRow) {
      rows.push({ ...line, words: [...line.words] })
      continue
    }

    const mergedLines = [matchingRow, line].sort((left, right) => left.bbox.x0 - right.bbox.x0)
    matchingRow.words = [...matchingRow.words, ...line.words]
      .sort((left, right) => left.bbox.x0 - right.bbox.x0)
    matchingRow.text = mergedLines.map((item) => item.text).join(' ')
    matchingRow.confidence = Math.min(matchingRow.confidence, line.confidence)
    matchingRow.bbox = unionBoundingBox(matchingRow.words)
  }

  return rows
}

function parseLine(line: OcrLineEvidence): ParsedLinePair[] {
  const sortedWords = [...line.words].sort((left, right) => left.bbox.x0 - right.bbox.x0)
  const rawEnglishWords = sortedWords
    .map((evidence) => ({ evidence, word: englishWordFromEvidence(evidence) }))
    .filter((item) => Boolean(item.word))
  const posEvidence = new Map<OcrWordEvidence, string>()

  for (const [index, evidence] of sortedWords.entries()) {
    const partOfSpeech = englishPartOfSpeechFromEvidence(evidence)
    if (!partOfSpeech) continue
    const neighboringEvidence = [sortedWords[index - 1], sortedWords[index + 1]].filter(Boolean)
    const hasAdjacentLexicalWord = rawEnglishWords.some((item) => (
      neighboringEvidence.includes(item.evidence)
      && !englishPartOfSpeechFromEvidence(item.evidence)
    ))
    if (hasAdjacentLexicalWord) posEvidence.set(evidence, partOfSpeech)
  }

  const lexicalEnglishWords = rawEnglishWords.filter((item) => !posEvidence.has(item.evidence))
  const posByWordEvidence = new Map<OcrWordEvidence, string[]>()
  for (const [evidence, partOfSpeech] of posEvidence) {
    const evidenceCenter = (evidence.bbox.x0 + evidence.bbox.x1) / 2
    const nearestWord = lexicalEnglishWords.reduce<(typeof lexicalEnglishWords)[number] | null>(
      (nearest, item) => {
        if (!nearest) return item
        const itemCenter = (item.evidence.bbox.x0 + item.evidence.bbox.x1) / 2
        const nearestCenter = (nearest.evidence.bbox.x0 + nearest.evidence.bbox.x1) / 2
        return Math.abs(itemCenter - evidenceCenter) < Math.abs(nearestCenter - evidenceCenter)
          ? item
          : nearest
      },
      null,
    )
    if (!nearestWord) continue
    const assigned = posByWordEvidence.get(nearestWord.evidence) ?? []
    if (!assigned.includes(partOfSpeech)) assigned.push(partOfSpeech)
    posByWordEvidence.set(nearestWord.evidence, assigned)
  }

  const classified = sortedWords
    .map((evidence) => {
      if (posEvidence.has(evidence)) return null
      const englishWord = englishWordFromEvidence(evidence)
      if (englishWord) return { kind: 'english' as const, evidence, englishWord }
      const koreanText = koreanTextFromEvidence(evidence)
      if (koreanText) return { kind: 'korean' as const, evidence, englishWord: '' }
      return null
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)

  if (classified.length < 2) return []

  const runs: Array<{
    kind: 'english' | 'korean'
    items: typeof classified
  }> = []
  for (const item of classified) {
    const current = runs[runs.length - 1]
    if (current?.kind === item.kind) current.items.push(item)
    else runs.push({ kind: item.kind, items: [item] })
  }

  const direction = runs[0]?.kind === 'english' ? 'english-first' : 'korean-first'
  if (runs.length % 2 !== 0) return []
  if (runs.some((run) => run.kind === 'english' && run.items.length !== 1)) return []
  for (let index = 0; index < runs.length; index += 1) {
    const expected = (index % 2 === 0)
      ? (direction === 'english-first' ? 'english' : 'korean')
      : (direction === 'english-first' ? 'korean' : 'english')
    if (runs[index].kind !== expected) return []
  }

  const pairs: ParsedLinePair[] = []
  for (let index = 0; index < runs.length; index += 2) {
    const englishRun = direction === 'english-first' ? runs[index] : runs[index + 1]
    const koreanRun = direction === 'english-first' ? runs[index + 1] : runs[index]
    const wordEvidence = englishRun.items[0].evidence
    const koreanEvidence = koreanRun.items.map((item) => item.evidence)
    let details = meaningFromEvidence(koreanEvidence)
    if (!details && koreanEvidence.length === 1) {
      const photographedMeaning = koreanTextFromEvidence(koreanEvidence[0])
      const lexicalPartOfSpeech = englishPartOfSpeechFromEvidence(wordEvidence)
      if (lexicalPartOfSpeech && normalizePosToken(photographedMeaning) === lexicalPartOfSpeech) {
        details = {
          meaning: photographedMeaning,
          partOfSpeech: lexicalPartOfSpeech,
          confidence: koreanEvidence[0].confidence,
        }
      }
    }
    if (!details) continue
    const englishBox = wordEvidence.bbox
    const koreanBox = unionBoundingBox(koreanEvidence)
    const horizontalGap = direction === 'english-first'
      ? koreanBox.x0 - englishBox.x1
      : englishBox.x0 - koreanBox.x1
    const rowHeight = Math.max(englishBox.y1 - englishBox.y0, koreanBox.y1 - koreanBox.y0, 1)
    const partOfSpeech = [...new Set([
      ...details.partOfSpeech.split('·'),
      ...(posByWordEvidence.get(wordEvidence) ?? []),
    ].filter(Boolean))].slice(0, 2).join('·')

    pairs.push({
      direction,
      hasSeparator: /[:=→↔]/u.test(line.text),
      wordEvidence,
      koreanEvidence,
      meaning: details.meaning,
      partOfSpeech,
      lineConfidence: effectiveLineConfidence(line),
      geometryStrong:
        horizontalGap >= -rowHeight * 0.2
        && horizontalGap <= rowHeight * 8
        && verticalOverlapRatio(englishBox, koreanBox) >= 0.55,
    })
  }
  return pairs
}

/**
 * Pairs only alternating English/Korean cells from the selected OCR pass.
 * Prose-like lines with consecutive English words are deliberately ignored.
 */
export function pairOcrLinesWithKoreanMeanings(
  lines: readonly OcrLineEvidence[],
): Map<string, OcrMeaningCandidate> {
  const parsed = coalesceOcrRows(lines).flatMap(parseLine)
  const directionCounts = parsed.reduce(
    (counts, pair) => ({ ...counts, [pair.direction]: counts[pair.direction] + 1 }),
    { 'english-first': 0, 'korean-first': 0 },
  )
  const candidates = new Map<string, OcrMeaningCandidate>()
  const conflicts = new Set<string>()

  for (const pair of parsed) {
    const word = englishWordFromEvidence(pair.wordEvidence)
    if (!word || conflicts.has(word)) continue
    const meaningConfidence = pair.koreanEvidence.reduce((sum, evidence) => {
      const count = hangulParts(evidence.text).join('').length
      return sum + evidence.confidence * Math.max(1, count)
    }, 0) / pair.koreanEvidence.reduce((sum, evidence) => (
      sum + Math.max(1, hangulParts(evidence.text).join('').length)
    ), 0)
    const candidate: OcrMeaningCandidate = {
      word,
      meaning: pair.meaning,
      partOfSpeech: pair.partOfSpeech,
      confidence: Math.min(pair.wordEvidence.confidence, meaningConfidence, pair.lineConfidence),
      layoutConfidence:
        pair.geometryStrong && (pair.hasSeparator || directionCounts[pair.direction] >= 2)
          ? 'strong'
          : 'single',
    }
    const existing = candidates.get(word)
    if (!existing) {
      candidates.set(word, candidate)
      continue
    }
    if (normalizeKoreanMeaning(existing.meaning) !== normalizeKoreanMeaning(candidate.meaning)) {
      candidates.delete(word)
      conflicts.add(word)
    } else if (candidate.confidence > existing.confidence) {
      candidates.set(word, candidate)
    }
  }

  return candidates
}

function normalizeKoreanMeaning(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/^[\s•·*\-–—]+/u, '')
    .replace(/[.!?。]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function dictionarySenseAtoms(value: string): string[] {
  return value
    .split(/[;\n·/]+/u)
    .map(normalizeKoreanMeaning)
    .filter(Boolean)
}

function meaningfulTokens(value: string): Set<string> {
  return new Set(
    hangulParts(value).filter(
      (token) => token.length >= 2 && !GENERIC_KOREAN_TOKENS.has(token),
    ),
  )
}

/** String-level validation only; uncertain never means the photographed meaning is wrong. */
export function compareOcrMeaningWithDictionary(
  candidate: OcrMeaningCandidate,
  dictionary: KoreanDictionaryEntry | undefined,
): OcrMeaningAgreement {
  if (!dictionary?.meaning.trim()) return 'uncertain'
  const observed = normalizeKoreanMeaning(candidate.meaning)
  const senses = dictionarySenseAtoms(dictionary.meaning)
  if (senses.includes(observed)) {
    return candidate.layoutConfidence === 'strong' && candidate.confidence >= 75
      ? 'exact'
      : 'related'
  }

  const observedTokens = meaningfulTokens(observed)
  const dictionaryTokens = meaningfulTokens(dictionary.meaning)
  const hasSharedToken = [...observedTokens].some((token) => dictionaryTokens.has(token))
  return hasSharedToken ? 'related' : 'uncertain'
}

/** Finds only obvious two-row swaps where both photographed meanings match the opposite entries exactly. */
export function findCrossSwappedMeaningWords(
  candidates: ReadonlyMap<string, OcrMeaningCandidate>,
  definitions: ReadonlyMap<string, KoreanDictionaryEntry>,
): Set<string> {
  const entries = [...candidates.entries()].filter(([word]) => definitions.has(word))
  const swapped = new Set<string>()

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const [leftWord, leftCandidate] = entries[leftIndex]
    const leftDefinition = definitions.get(leftWord)
    if (compareOcrMeaningWithDictionary(leftCandidate, leftDefinition) === 'exact') continue

    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [rightWord, rightCandidate] = entries[rightIndex]
      const rightDefinition = definitions.get(rightWord)
      if (compareOcrMeaningWithDictionary(rightCandidate, rightDefinition) === 'exact') continue
      if (
        compareOcrMeaningWithDictionary(leftCandidate, rightDefinition) === 'exact'
        && compareOcrMeaningWithDictionary(rightCandidate, leftDefinition) === 'exact'
      ) {
        swapped.add(leftWord)
        swapped.add(rightWord)
      }
    }
  }

  return swapped
}
