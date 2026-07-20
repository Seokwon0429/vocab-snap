import nspell from 'nspell'
import { isPlausibleEnglishWord, normalizeEnglishWord } from './wordExtraction'

const DICTIONARY_ASSETS = {
  aff: 'ocr/dictionary/en.aff',
  dic: 'ocr/dictionary/en.dic',
} as const

const SIMPLE_ENGLISH_WORD = /^[a-z]+$/

export interface CorrectionSuggestion {
  word: string
  rank: number
}

export interface CorrectionInput {
  word: string
  confidence?: number
}

export interface CorrectionOptions {
  maxSuggestions?: number
  knownWords?: Iterable<string>
}

interface SpellChecker {
  correct: (word: string) => boolean
  suggest: (word: string) => string[]
  add: (word: string) => void
}

function dictionaryAssetUrl(path: string): string {
  if (typeof document === 'undefined') {
    throw new Error('교정 사전은 브라우저에서만 불러올 수 있습니다.')
  }

  return new URL(path, document.baseURI).href
}

async function fetchDictionaryText(path: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(dictionaryAssetUrl(path), { cache: 'force-cache' })
  if (!response.ok) {
    throw new Error(`교정 사전을 불러오지 못했습니다. (${response.status})`)
  }
  return response.text()
}

/** Adjacent transpositions count as one edit, which is common in OCR output. */
export function boundedDamerauLevenshtein(
  source: string,
  target: string,
  maxDistance: number,
): number {
  if (source === target) return 0
  if (Math.abs(source.length - target.length) > maxDistance) return maxDistance + 1

  let previousPrevious = new Array<number>(target.length + 1).fill(0)
  let previous = Array.from({ length: target.length + 1 }, (_, index) => index)

  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const current = new Array<number>(target.length + 1).fill(0)
    current[0] = sourceIndex
    let rowMinimum = current[0]

    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      const substitutionCost = source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1
      current[targetIndex] = Math.min(
        previous[targetIndex] + 1,
        current[targetIndex - 1] + 1,
        previous[targetIndex - 1] + substitutionCost,
      )

      if (
        sourceIndex > 1
        && targetIndex > 1
        && source[sourceIndex - 1] === target[targetIndex - 2]
        && source[sourceIndex - 2] === target[targetIndex - 1]
      ) {
        current[targetIndex] = Math.min(
          current[targetIndex],
          previousPrevious[targetIndex - 2] + 1,
        )
      }

      rowMinimum = Math.min(rowMinimum, current[targetIndex])
    }

    if (rowMinimum > maxDistance) return maxDistance + 1
    previousPrevious = previous
    previous = current
  }

  const distance = previous[target.length]
  return distance <= maxDistance ? distance : maxDistance + 1
}

function isCorrect(spell: SpellChecker, word: string): boolean {
  if (spell.correct(word)) return true
  if (word.includes('-')) return word.split('-').every((segment) => spell.correct(segment))
  if (word.endsWith("'s")) return spell.correct(word.slice(0, -2))
  return false
}

function normalizedSuggestions(
  spell: SpellChecker,
  word: string,
  maxSuggestions: number,
): CorrectionSuggestion[] {
  const maxDistance = word.replace(/['-]/g, '').length <= 5 ? 1 : 2
  let rawSuggestions: string[]

  if (word.includes('-')) {
    const segments = word.split('-')
    const invalidIndex = segments.findIndex((segment) => !spell.correct(segment))
    if (invalidIndex < 0) return []
    rawSuggestions = spell.suggest(segments[invalidIndex]).map((suggestion) => (
      segments.map((segment, index) => index === invalidIndex ? suggestion : segment).join('-')
    ))
  } else {
    rawSuggestions = spell.suggest(word)
  }

  const seen = new Set<string>()
  const suggestions: CorrectionSuggestion[] = []
  for (const rawSuggestion of rawSuggestions) {
    const suggestion = normalizeEnglishWord(rawSuggestion)
    if (
      !suggestion
      || suggestion === word
      || seen.has(suggestion)
      || !isPlausibleEnglishWord(suggestion)
      || boundedDamerauLevenshtein(word, suggestion, maxDistance) > maxDistance
    ) {
      continue
    }

    seen.add(suggestion)
    suggestions.push({ word: suggestion, rank: suggestions.length + 1 })
    if (suggestions.length >= maxSuggestions) break
  }

  return suggestions
}

export class EnglishCorrectionDictionary {
  constructor(private readonly spell: SpellChecker) {}

  has(word: string): boolean {
    const normalized = normalizeEnglishWord(word)
    return Boolean(normalized && isCorrect(this.spell, normalized))
  }

  add(word: string): void {
    const normalized = normalizeEnglishWord(word)
    if (normalized) this.spell.add(normalized)
  }

  suggest(rawWord: string, options: CorrectionOptions = {}): CorrectionSuggestion[] {
    const word = normalizeEnglishWord(rawWord)
    if (
      !word
      || word.length < 3
      || (!SIMPLE_ENGLISH_WORD.test(word) && !word.includes('-'))
      || isCorrect(this.spell, word)
    ) {
      return []
    }

    return normalizedSuggestions(this.spell, word, Math.max(1, options.maxSuggestions ?? 3))
  }
}

let dictionaryPromise: Promise<EnglishCorrectionDictionary> | undefined

export async function loadEnglishCorrectionDictionary(
  fetcher: typeof fetch = fetch,
): Promise<EnglishCorrectionDictionary> {
  if (!dictionaryPromise) {
    dictionaryPromise = Promise.all([
      fetchDictionaryText(DICTIONARY_ASSETS.aff, fetcher),
      fetchDictionaryText(DICTIONARY_ASSETS.dic, fetcher),
    ])
      .then(([aff, dic]) => new EnglishCorrectionDictionary(nspell({ aff, dic })))
      .catch((error) => {
        dictionaryPromise = undefined
        throw error
      })
  }

  return dictionaryPromise
}

/**
 * Returns local suggestions only. Recognized text is never sent anywhere and a
 * word is never changed until the learner explicitly chooses a suggestion.
 */
export async function suggestCorrectionsForWords(
  inputs: Iterable<CorrectionInput>,
  options: CorrectionOptions = {},
): Promise<Map<string, CorrectionSuggestion[]>> {
  const dictionary = await loadEnglishCorrectionDictionary()
  for (const knownWord of options.knownWords ?? []) dictionary.add(knownWord)

  const results = new Map<string, CorrectionSuggestion[]>()
  for (const input of inputs) {
    const word = normalizeEnglishWord(input.word)
    if (!word || results.has(word)) continue

    const suggestions = dictionary.suggest(word, options)
    if (suggestions.length) results.set(word, suggestions)
  }

  return results
}
