import {
  extractEnglishWords,
  isPlausibleEnglishWord,
  normalizeEnglishWord,
} from './wordExtraction'

const MAX_TEXT_LENGTH = 100_000
const MAX_CANDIDATES = 500

const PART_OF_SPEECH: Readonly<Record<string, string>> = {
  n: '명사',
  noun: '명사',
  v: '동사',
  verb: '동사',
  adj: '형용사',
  adjective: '형용사',
  adv: '부사',
  adverb: '부사',
  pron: '대명사',
  prep: '전치사',
  conj: '접속사',
}

export interface PastedTextCandidate {
  word: string
  meaning: string
  partOfSpeech: string
  explicitMeaning: boolean
}

export interface PastedTextParseResult {
  candidates: PastedTextCandidate[]
  duplicateWords: string[]
  truncated: boolean
}

function removeListMarker(line: string): string {
  return line
    .replace(/^\s*(?:[-*•▪◦]\s+|\d{1,5}[.)]\s*)/u, '')
    .trim()
}

function parsePair(line: string): PastedTextCandidate | null {
  const cleaned = removeListMarker(line)
  const match = cleaned.match(/^(.+?)(?:\t+|\s*[:=→]\s*|\s+[-–—]\s+)(.+)$/u)
  if (!match) return null

  const left = match[1].trim()
  const headword = left.match(
    /^([A-Za-z]+(?:['’-][A-Za-z]+)*)(?:\s*[([]?\s*(n|noun|v|verb|adj|adjective|adv|adverb|pron|prep|conj)\.?\s*[)\]]?)?$/iu,
  )
  if (!headword) return null

  const word = normalizeEnglishWord(headword[1])
  const meaning = match[2].trim()
  if (!word || !isPlausibleEnglishWord(word) || !/[가-힣]/u.test(meaning)) return null

  return {
    word,
    meaning,
    partOfSpeech: PART_OF_SPEECH[headword[2]?.toLocaleLowerCase('en-US') ?? ''] ?? '',
    explicitMeaning: true,
  }
}

export function parsePastedVocabularyText(text: string): PastedTextParseResult {
  const source = text.slice(0, MAX_TEXT_LENGTH)
  const candidates = new Map<string, PastedTextCandidate>()
  const occurrences = new Map<string, number>()
  let reachedCandidateLimit = false

  const addCandidate = (candidate: PastedTextCandidate) => {
    occurrences.set(candidate.word, (occurrences.get(candidate.word) ?? 0) + 1)
    const existing = candidates.get(candidate.word)
    if (existing) {
      if (!existing.meaning && candidate.meaning) candidates.set(candidate.word, candidate)
      return
    }
    if (candidates.size >= MAX_CANDIDATES) {
      reachedCandidateLimit = true
      return
    }
    candidates.set(candidate.word, candidate)
  }

  for (const line of source.split(/\r?\n/u)) {
    const pair = parsePair(line)
    if (pair) {
      addCandidate(pair)
      continue
    }

    const extracted = extractEnglishWords(line, { minLetters: 2 })
    for (const word of extracted.words) {
      addCandidate({
        word,
        meaning: '',
        partOfSpeech: '',
        explicitMeaning: false,
      })
    }
    for (const duplicate of extracted.duplicateWords) {
      occurrences.set(duplicate, Math.max(2, occurrences.get(duplicate) ?? 0))
    }
  }

  return {
    candidates: [...candidates.values()],
    duplicateWords: [...occurrences.entries()]
      .filter(([, count]) => count > 1)
      .map(([word]) => word),
    truncated: text.length > MAX_TEXT_LENGTH || reachedCandidateLimit,
  }
}
