import type {
  AddManyResult,
  ImportMode,
  ImportResult,
  QuizResult,
  QuizStats,
  WordEntry,
  WordEntryInput,
  WordQuizStats,
} from '../types'

const DB_NAME = 'photo-english-vocabulary'
const DB_VERSION = 1
const WORD_STORE = 'words'
const NORMALIZED_WORD_INDEX = 'by-normalized-word'
const CREATED_AT_INDEX = 'by-created-at'
const UPDATED_AT_INDEX = 'by-updated-at'

let databasePromise: Promise<IDBDatabase> | null = null

export class DuplicateWordError extends Error {
  readonly normalizedWord: string

  constructor(word: string) {
    super(`이미 단어장에 있는 단어입니다: ${word}`)
    this.name = 'DuplicateWordError'
    this.normalizedWord = normalizeWord(word)
  }
}

export class StorageUnavailableError extends Error {
  constructor(message = '이 브라우저에서는 IndexedDB를 사용할 수 없습니다.') {
    super(message)
    this.name = 'StorageUnavailableError'
  }
}

/** Produces the canonical, case-insensitive key used for duplicate detection. */
export function normalizeWord(word: string): string {
  return word
    .trim()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLocaleLowerCase('en-US')
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0
}

function safeIsoDate(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return fallback
  }

  return new Date(value).toISOString()
}

function makeId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const random = Math.random().toString(36).slice(2)
  return `word-${Date.now().toString(36)}-${random}`
}

function normalizeQuizStats(
  stats: Partial<WordQuizStats> | undefined,
): WordQuizStats {
  const knownCount = safeCount(stats?.knownCount)
  const unknownCount = safeCount(stats?.unknownCount)
  const attempts = Math.max(
    safeCount(stats?.attempts),
    knownCount + unknownCount,
  )
  const lastResult =
    stats?.lastResult === 'known' || stats?.lastResult === 'unknown'
      ? stats.lastResult
      : null

  return {
    attempts,
    knownCount,
    unknownCount,
    lastResult,
    lastReviewedAt:
      typeof stats?.lastReviewedAt === 'string' &&
      !Number.isNaN(Date.parse(stats.lastReviewedAt))
        ? new Date(stats.lastReviewedAt).toISOString()
        : null,
  }
}

function prepareEntry(
  input: WordEntryInput,
  options: { id?: string; createdAt?: string } = {},
): WordEntry {
  const now = new Date().toISOString()
  const word = safeString(input.word)
  const normalizedWord = normalizeWord(word)

  if (!normalizedWord) {
    throw new TypeError('단어는 비워 둘 수 없습니다.')
  }

  const createdAt = safeIsoDate(options.createdAt ?? input.createdAt, now)

  return {
    id: options.id || safeString(input.id) || makeId(),
    word,
    normalizedWord,
    meaning: safeString(input.meaning),
    partOfSpeech: safeString(input.partOfSpeech),
    memo: safeString(input.memo),
    createdAt,
    updatedAt: safeIsoDate(input.updatedAt, now),
    quizStats: normalizeQuizStats(input.quizStats),
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    })
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('IndexedDB 요청에 실패했습니다.')),
      { once: true },
    )
  })
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener(
      'abort',
      () =>
        reject(
          transaction.error ?? new Error('IndexedDB 작업이 취소되었습니다.'),
        ),
      { once: true },
    )
    transaction.addEventListener(
      'error',
      () =>
        reject(transaction.error ?? new Error('IndexedDB 작업에 실패했습니다.')),
      { once: true },
    )
  })
}

function configureWordStore(store: IDBObjectStore): void {
  if (!store.indexNames.contains(NORMALIZED_WORD_INDEX)) {
    store.createIndex(NORMALIZED_WORD_INDEX, 'normalizedWord', { unique: true })
  }
  if (!store.indexNames.contains(CREATED_AT_INDEX)) {
    store.createIndex(CREATED_AT_INDEX, 'createdAt')
  }
  if (!store.indexNames.contains(UPDATED_AT_INDEX)) {
    store.createIndex(UPDATED_AT_INDEX, 'updatedAt')
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise
  }

  if (typeof globalThis.indexedDB === 'undefined') {
    return Promise.reject(new StorageUnavailableError())
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION)

    request.addEventListener('upgradeneeded', () => {
      const database = request.result
      const store = database.objectStoreNames.contains(WORD_STORE)
        ? request.transaction!.objectStore(WORD_STORE)
        : database.createObjectStore(WORD_STORE, { keyPath: 'id' })

      configureWordStore(store)
    })

    request.addEventListener(
      'success',
      () => {
        const database = request.result
        database.addEventListener('versionchange', () => {
          database.close()
          databasePromise = null
        })
        resolve(database)
      },
      { once: true },
    )

    request.addEventListener(
      'error',
      () => {
        databasePromise = null
        reject(request.error ?? new StorageUnavailableError())
      },
      { once: true },
    )

    request.addEventListener(
      'blocked',
      () => {
        databasePromise = null
        reject(
          new StorageUnavailableError(
            '다른 탭에서 단어장을 사용 중입니다. 다른 탭을 닫고 다시 시도해 주세요.',
          ),
        )
      },
      { once: true },
    )
  })

  return databasePromise
}

function isConstraintError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'ConstraintError'
}

function sortNewestFirst(entries: WordEntry[]): WordEntry[] {
  return entries.sort(
    (left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
      left.normalizedWord.localeCompare(right.normalizedWord, 'en'),
  )
}

/** Returns every stored word, newest first. */
export async function getAll(): Promise<WordEntry[]> {
  const database = await openDatabase()
  const transaction = database.transaction(WORD_STORE, 'readonly')
  const completion = transactionToPromise(transaction)
  const entries = await requestToPromise(
    transaction.objectStore(WORD_STORE).getAll() as IDBRequest<WordEntry[]>,
  )
  await completion
  return sortNewestFirst(entries)
}

export async function getById(id: string): Promise<WordEntry | undefined> {
  const database = await openDatabase()
  const transaction = database.transaction(WORD_STORE, 'readonly')
  const completion = transactionToPromise(transaction)
  const entry = await requestToPromise(
    transaction.objectStore(WORD_STORE).get(id) as IDBRequest<
      WordEntry | undefined
    >,
  )
  await completion
  return entry
}

/** Adds valid, non-duplicate words and reports skipped duplicates. */
export async function addMany(
  inputs: readonly WordEntryInput[],
): Promise<AddManyResult> {
  if (inputs.length === 0) {
    return { added: [], duplicates: [] }
  }

  const existing = await getAll()
  const usedWords = new Set(existing.map((entry) => entry.normalizedWord))
  const usedIds = new Set(existing.map((entry) => entry.id))
  const added: WordEntry[] = []
  const duplicates: WordEntryInput[] = []

  for (const input of inputs) {
    const normalizedWord = normalizeWord(input.word)
    if (usedWords.has(normalizedWord)) {
      duplicates.push(input)
      continue
    }

    let id = safeString(input.id)
    if (!id || usedIds.has(id)) {
      do {
        id = makeId()
      } while (usedIds.has(id))
    }

    const entry = prepareEntry(input, { id })
    usedWords.add(entry.normalizedWord)
    usedIds.add(entry.id)
    added.push(entry)
  }

  if (added.length === 0) {
    return { added, duplicates }
  }

  const database = await openDatabase()
  const transaction = database.transaction(WORD_STORE, 'readwrite')
  const completion = transactionToPromise(transaction)
  const store = transaction.objectStore(WORD_STORE)

  try {
    for (const entry of added) {
      store.add(entry)
    }
    await completion
  } catch (error) {
    await completion.catch(() => undefined)
    if (isConstraintError(error)) {
      throw new DuplicateWordError(added[0].word)
    }
    throw error
  }

  return { added, duplicates }
}

/** Creates or updates one entry. Existing omitted fields are preserved. */
export async function put(input: WordEntryInput): Promise<WordEntry> {
  const existing = input.id ? await getById(input.id) : undefined
  const merged: WordEntryInput = existing
    ? {
        ...existing,
        ...input,
        quizStats: { ...existing.quizStats, ...input.quizStats },
      }
    : input
  const entry = prepareEntry(merged, {
    id: existing?.id ?? (safeString(input.id) || makeId()),
    createdAt: existing?.createdAt,
  })

  // A user edit is always considered a new update, even if imported timestamps exist.
  entry.updatedAt = new Date().toISOString()

  const database = await openDatabase()
  const transaction = database.transaction(WORD_STORE, 'readwrite')
  const completion = transactionToPromise(transaction)

  try {
    transaction.objectStore(WORD_STORE).put(entry)
    await completion
  } catch (error) {
    await completion.catch(() => undefined)
    if (isConstraintError(error)) {
      throw new DuplicateWordError(entry.word)
    }
    throw error
  }

  return entry
}

export async function deleteMany(ids: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return 0
  }

  const database = await openDatabase()
  const transaction = database.transaction(WORD_STORE, 'readwrite')
  const completion = transactionToPromise(transaction)
  const store = transaction.objectStore(WORD_STORE)

  for (const id of uniqueIds) {
    store.delete(id)
  }
  await completion
  return uniqueIds.length
}

export async function clear(): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(WORD_STORE, 'readwrite')
  const completion = transactionToPromise(transaction)
  transaction.objectStore(WORD_STORE).clear()
  await completion
}

/** Atomically replaces the vocabulary. Duplicate words in the input are skipped. */
export async function replaceAll(
  inputs: readonly WordEntryInput[],
): Promise<AddManyResult> {
  const usedWords = new Set<string>()
  const usedIds = new Set<string>()
  const added: WordEntry[] = []
  const duplicates: WordEntryInput[] = []

  for (const input of inputs) {
    const normalizedWord = normalizeWord(input.word)
    if (usedWords.has(normalizedWord)) {
      duplicates.push(input)
      continue
    }

    let id = safeString(input.id)
    if (!id || usedIds.has(id)) {
      do {
        id = makeId()
      } while (usedIds.has(id))
    }

    const entry = prepareEntry(input, { id })
    usedWords.add(entry.normalizedWord)
    usedIds.add(entry.id)
    added.push(entry)
  }

  const database = await openDatabase()
  const transaction = database.transaction(WORD_STORE, 'readwrite')
  const completion = transactionToPromise(transaction)
  const store = transaction.objectStore(WORD_STORE)
  store.clear()
  for (const entry of added) {
    store.add(entry)
  }
  await completion

  return { added, duplicates }
}

export async function importEntries(
  inputs: readonly WordEntryInput[],
  mode: ImportMode = 'merge',
): Promise<ImportResult> {
  const result =
    mode === 'replace' ? await replaceAll(inputs) : await addMany(inputs)
  return { ...result, mode }
}

/** Records a quiz judgement without requiring the UI to update counters itself. */
export async function recordQuizResult(
  id: string,
  result: QuizResult,
): Promise<WordEntry> {
  const entry = await getById(id)
  if (!entry) {
    throw new Error('학습 기록을 저장할 단어를 찾지 못했습니다.')
  }

  const quizStats: WordQuizStats = {
    attempts: entry.quizStats.attempts + 1,
    knownCount:
      entry.quizStats.knownCount + (result === 'known' ? 1 : 0),
    unknownCount:
      entry.quizStats.unknownCount + (result === 'unknown' ? 1 : 0),
    lastResult: result,
    lastReviewedAt: new Date().toISOString(),
  }

  return put({ ...entry, quizStats })
}

export function calculateQuizStats(entries: readonly WordEntry[]): QuizStats {
  const knownCount = entries.reduce(
    (sum, entry) => sum + entry.quizStats.knownCount,
    0,
  )
  const unknownCount = entries.reduce(
    (sum, entry) => sum + entry.quizStats.unknownCount,
    0,
  )
  const totalAttempts = entries.reduce(
    (sum, entry) => sum + entry.quizStats.attempts,
    0,
  )

  return {
    totalWords: entries.length,
    studiedWords: entries.filter((entry) => entry.quizStats.attempts > 0).length,
    totalAttempts,
    knownCount,
    unknownCount,
    accuracy:
      totalAttempts === 0
        ? 0
        : Math.round((knownCount / totalAttempts) * 10_000) / 100,
  }
}

export async function getQuizStats(): Promise<QuizStats> {
  return calculateQuizStats(await getAll())
}

/** Closes the cached connection; useful before tests or a future schema upgrade. */
export async function closeDatabase(): Promise<void> {
  if (!databasePromise) {
    return
  }

  const database = await databasePromise.catch(() => null)
  database?.close()
  databasePromise = null
}
