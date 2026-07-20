import type { WordEntryInput } from '../types'
import { normalizeWord } from './db'
import { koreanDictionarySupplement } from './koreanDictionarySupplement'

interface CompactDictionaryEntry {
  m: string
  p: string
}

export interface KoreanDictionaryEntry {
  meaning: string
  partOfSpeech: string
}

export interface EnrichmentResult {
  entries: WordEntryInput[]
  matchedCount: number
  unavailable: boolean
}

type DictionaryChunk = Record<string, CompactDictionaryEntry>

const DICTIONARY_ASSET_VERSION = '2'
const chunkPromises = new Map<string, Promise<DictionaryChunk>>()

function chunkKey(word: string): string | null {
  const first = normalizeWord(word)[0]
  return first && /^[a-z]$/.test(first) ? first : null
}

function dictionaryAssetUrl(letter: string): string {
  const baseUrl =
    typeof document === 'undefined'
      ? 'http://localhost/'
      : document.baseURI
  const url = new URL(`dictionary/ko-en/${letter}.json`, baseUrl)
  url.searchParams.set('v', DICTIONARY_ASSET_VERSION)
  return url.toString()
}

function isDictionaryChunk(value: unknown): value is DictionaryChunk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(
    (entry) =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as CompactDictionaryEntry).m === 'string' &&
      typeof (entry as CompactDictionaryEntry).p === 'string',
  )
}

async function loadChunk(letter: string): Promise<DictionaryChunk> {
  const cached = chunkPromises.get(letter)
  if (cached) return cached

  const request = fetch(dictionaryAssetUrl(letter), { cache: 'force-cache' })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`한글 뜻 사전을 불러오지 못했습니다 (${response.status}).`)
      }
      const parsed: unknown = await response.json()
      if (!isDictionaryChunk(parsed)) {
        throw new Error('한글 뜻 사전 파일 형식이 올바르지 않습니다.')
      }
      return parsed
    })
    .catch((error) => {
      chunkPromises.delete(letter)
      throw error
    })

  chunkPromises.set(letter, request)
  return request
}

/** Looks up words in same-origin static assets. No word is sent to an external service. */
export async function lookupKoreanDefinitions(
  words: readonly string[],
): Promise<{ definitions: Map<string, KoreanDictionaryEntry>; unavailable: boolean }> {
  const normalizedWords = [...new Set(words.map(normalizeWord).filter(Boolean))]
  const groups = new Map<string, string[]>()
  const definitions = new Map<string, KoreanDictionaryEntry>()

  for (const word of normalizedWords) {
    const supplemental = koreanDictionarySupplement[word]
    if (supplemental) {
      definitions.set(word, { ...supplemental })
      continue
    }
    const key = chunkKey(word)
    if (!key) continue
    groups.set(key, [...(groups.get(key) ?? []), word])
  }

  let unavailable = false

  await Promise.all(
    [...groups].map(async ([letter, groupedWords]) => {
      try {
        const chunk = await loadChunk(letter)
        for (const word of groupedWords) {
          const match = chunk[word]
          if (!match) continue
          definitions.set(word, {
            meaning: match.m || '',
            partOfSpeech: match.p || '',
          })
        }
      } catch {
        unavailable = true
      }
    }),
  )

  return { definitions, unavailable }
}

/** Fills only blank fields, preserving every meaning/POS entered by the user. */
export async function enrichWithKoreanDefinitions(
  inputs: readonly WordEntryInput[],
): Promise<EnrichmentResult> {
  const { definitions, unavailable } = await lookupKoreanDefinitions(
    inputs.map((entry) => entry.word),
  )
  let matchedCount = 0

  const entries = inputs.map((entry) => {
    const match = definitions.get(normalizeWord(entry.word))
    if (!match) return { ...entry }

    const meaning = entry.meaning?.trim() || match.meaning
    const partOfSpeech = entry.partOfSpeech?.trim() || match.partOfSpeech
    if (meaning !== (entry.meaning ?? '') || partOfSpeech !== (entry.partOfSpeech ?? '')) {
      matchedCount += 1
    }
    return { ...entry, meaning, partOfSpeech }
  })

  return { entries, matchedCount, unavailable }
}

/** Test helper: allows a failed or mocked request to be retried. */
export function resetKoreanDictionaryCache(): void {
  chunkPromises.clear()
}
