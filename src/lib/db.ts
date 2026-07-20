import type {
  AddManyResult,
  DeleteFolderResult,
  ImportMode,
  ImportResult,
  QuizResult,
  QuizStats,
  VocabularyFolder,
  VocabularyFolderInput,
  WordEntry,
  WordEntryInput,
  WordQuizStats,
} from '../types'

const DB_NAME = 'photo-english-vocabulary'
const DB_VERSION = 2
const WORD_STORE = 'words'
const FOLDER_STORE = 'folders'
const NORMALIZED_WORD_INDEX = 'by-normalized-word'
const CREATED_AT_INDEX = 'by-created-at'
const UPDATED_AT_INDEX = 'by-updated-at'
const FOLDER_ID_INDEX = 'by-folder-id'
const NORMALIZED_FOLDER_NAME_INDEX = 'by-normalized-name'
const FOLDER_CREATED_AT_INDEX = 'by-created-at'

type StoredWordEntry = WordEntry & { folderId: string | null }

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

export class DuplicateFolderError extends Error {
  readonly normalizedName: string

  constructor(name: string) {
    super(`같은 이름의 폴더가 이미 있습니다: ${name}`)
    this.name = 'DuplicateFolderError'
    this.normalizedName = normalizeFolderName(name)
  }
}

export class FolderNotFoundError extends Error {
  readonly folderId: string

  constructor(folderId: string) {
    super('폴더를 찾을 수 없습니다.')
    this.name = 'FolderNotFoundError'
    this.folderId = folderId
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

/** Produces the canonical key used for case-insensitive folder-name matching. */
export function normalizeFolderName(name: string): string {
  return name
    .trim()
    .replace(/\s+/gu, ' ')
    .normalize('NFC')
    .toLocaleLowerCase('ko-KR')
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

function makeId(prefix = 'word'): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const random = Math.random().toString(36).slice(2)
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

function normalizeFolderId(value: unknown): string | null {
  const id = safeString(value)
  return id || null
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
): StoredWordEntry {
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
    folderId: normalizeFolderId(input.folderId),
    createdAt,
    updatedAt: safeIsoDate(input.updatedAt, now),
    quizStats: normalizeQuizStats(input.quizStats),
  }
}

function prepareFolder(
  input: VocabularyFolderInput,
  options: { id?: string; createdAt?: string } = {},
): VocabularyFolder {
  const now = new Date().toISOString()
  const name = safeString(input.name).replace(/\s+/gu, ' ').normalize('NFC')
  const normalizedName = normalizeFolderName(name)

  if (!normalizedName) {
    throw new TypeError('폴더 이름은 비워 둘 수 없습니다.')
  }

  if (name.length > 80) {
    throw new TypeError('폴더 이름은 80자 이하여야 합니다.')
  }

  return {
    id: options.id || safeString(input.id) || makeId('folder'),
    name,
    normalizedName,
    createdAt: safeIsoDate(options.createdAt ?? input.createdAt, now),
    updatedAt: safeIsoDate(input.updatedAt, now),
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
  if (!store.indexNames.contains(FOLDER_ID_INDEX)) {
    store.createIndex(FOLDER_ID_INDEX, 'folderId')
  }
}

function configureFolderStore(store: IDBObjectStore): void {
  if (!store.indexNames.contains(NORMALIZED_FOLDER_NAME_INDEX)) {
    store.createIndex(NORMALIZED_FOLDER_NAME_INDEX, 'normalizedName', {
      unique: true,
    })
  }
  if (!store.indexNames.contains(FOLDER_CREATED_AT_INDEX)) {
    store.createIndex(FOLDER_CREATED_AT_INDEX, 'createdAt')
  }
}

function migrateLegacyWords(store: IDBObjectStore): void {
  const request = store.openCursor()
  request.addEventListener('success', () => {
    const cursor = request.result
    if (!cursor) return

    const value = cursor.value as Partial<WordEntry>
    if (typeof value.folderId !== 'string' && value.folderId !== null) {
      cursor.update({ ...value, folderId: null })
    }
    cursor.continue()
  })
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

    request.addEventListener('upgradeneeded', (event) => {
      const database = request.result
      const wordStore = database.objectStoreNames.contains(WORD_STORE)
        ? request.transaction!.objectStore(WORD_STORE)
        : database.createObjectStore(WORD_STORE, { keyPath: 'id' })

      configureWordStore(wordStore)

      const folderStore = database.objectStoreNames.contains(FOLDER_STORE)
        ? request.transaction!.objectStore(FOLDER_STORE)
        : database.createObjectStore(FOLDER_STORE, { keyPath: 'id' })
      configureFolderStore(folderStore)

      if (event.oldVersion < 2) {
        migrateLegacyWords(wordStore)
      }
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

function withFolderId(entry: WordEntry): StoredWordEntry {
  return entry.folderId === null || typeof entry.folderId === 'string'
    ? (entry as StoredWordEntry)
    : { ...entry, folderId: null }
}

function sortFolders(folders: VocabularyFolder[]): VocabularyFolder[] {
  return folders.sort(
    (left, right) =>
      left.normalizedName.localeCompare(right.normalizedName, 'ko') ||
      left.createdAt.localeCompare(right.createdAt),
  )
}

async function assertFolderExistsInTransaction(
  transaction: IDBTransaction,
  folderId: string | null,
): Promise<void> {
  if (folderId === null) return

  const key = await requestToPromise(
    transaction.objectStore(FOLDER_STORE).getKey(folderId),
  )
  if (key === undefined) {
    throw new FolderNotFoundError(folderId)
  }
}

async function assertFolderIdsExistInTransaction(
  transaction: IDBTransaction,
  folderIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(folderIds.map(safeString).filter(Boolean))]
  if (uniqueIds.length === 0) return

  const store = transaction.objectStore(FOLDER_STORE)
  const keys = await Promise.all(
    uniqueIds.map((id) => requestToPromise(store.getKey(id))),
  )
  const missingIndex = keys.findIndex((key) => key === undefined)
  if (missingIndex >= 0) {
    throw new FolderNotFoundError(uniqueIds[missingIndex])
  }
}

async function abortTransaction(transaction: IDBTransaction): Promise<void> {
  try {
    transaction.abort()
  } catch {
    // The transaction may already have aborted because of a failed request.
  }
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
  return sortNewestFirst(entries.map(withFolderId))
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
  return entry ? withFolderId(entry) : undefined
}

/** Returns every user-created folder. The built-in unfiled view is not stored. */
export async function getFolders(): Promise<VocabularyFolder[]> {
  const database = await openDatabase()
  const transaction = database.transaction(FOLDER_STORE, 'readonly')
  const completion = transactionToPromise(transaction)
  const folders = await requestToPromise(
    transaction.objectStore(FOLDER_STORE).getAll() as IDBRequest<
      VocabularyFolder[]
    >,
  )
  await completion
  return sortFolders(folders)
}

/** Creates a folder. Folder names are unique after trimming and case folding. */
export async function createFolder(name: string): Promise<VocabularyFolder> {
  const folder = prepareFolder({ name })
  const database = await openDatabase()
  const transaction = database.transaction(FOLDER_STORE, 'readwrite')
  const completion = transactionToPromise(transaction)

  try {
    await requestToPromise(transaction.objectStore(FOLDER_STORE).add(folder))
    await completion
    return folder
  } catch (error) {
    await completion.catch(() => undefined)
    if (isConstraintError(error)) {
      throw new DuplicateFolderError(folder.name)
    }
    throw error
  }
}

/** Renames a folder without changing its id or any word references. */
export async function renameFolder(
  id: string,
  name: string,
): Promise<VocabularyFolder> {
  const folderId = safeString(id)
  if (!folderId) throw new FolderNotFoundError(id)

  const database = await openDatabase()
  const transaction = database.transaction(FOLDER_STORE, 'readwrite')
  const completion = transactionToPromise(transaction)
  const store = transaction.objectStore(FOLDER_STORE)

  try {
    const existing = await requestToPromise(
      store.get(folderId) as IDBRequest<VocabularyFolder | undefined>,
    )
    if (!existing) {
      await abortTransaction(transaction)
      throw new FolderNotFoundError(folderId)
    }

    const renamed = prepareFolder(
      { ...existing, name, updatedAt: new Date().toISOString() },
      { id: existing.id, createdAt: existing.createdAt },
    )
    await requestToPromise(store.put(renamed))
    await completion
    return renamed
  } catch (error) {
    await completion.catch(() => undefined)
    if (isConstraintError(error)) {
      throw new DuplicateFolderError(name)
    }
    throw error
  }
}

/** Moves one or more words to a folder, or to the built-in unfiled view. */
export async function moveWordsToFolder(
  ids: readonly string[],
  folderId: string | null,
): Promise<number> {
  const uniqueIds = [...new Set(ids.map(safeString).filter(Boolean))]
  if (uniqueIds.length === 0) return 0

  const targetFolderId = normalizeFolderId(folderId)
  const database = await openDatabase()
  const transaction = database.transaction(
    [WORD_STORE, FOLDER_STORE],
    'readwrite',
  )
  const completion = transactionToPromise(transaction)
  const wordStore = transaction.objectStore(WORD_STORE)

  try {
    const targetRequest =
      targetFolderId === null
        ? Promise.resolve<IDBValidKey | undefined>(undefined)
        : requestToPromise(
            transaction.objectStore(FOLDER_STORE).getKey(targetFolderId),
          )
    const wordRequests = uniqueIds.map((id) =>
      requestToPromise(
        wordStore.get(id) as IDBRequest<WordEntry | undefined>,
      ),
    )
    const [targetKey, words] = await Promise.all([
      targetRequest,
      Promise.all(wordRequests),
    ])

    if (targetFolderId !== null && targetKey === undefined) {
      await abortTransaction(transaction)
      throw new FolderNotFoundError(targetFolderId)
    }

    const now = new Date().toISOString()
    let moved = 0
    for (const rawWord of words) {
      if (!rawWord) continue
      const word = withFolderId(rawWord)
      if (word.folderId === targetFolderId) continue
      wordStore.put({ ...word, folderId: targetFolderId, updatedAt: now })
      moved += 1
    }

    await completion
    return moved
  } catch (error) {
    await completion.catch(() => undefined)
    throw error
  }
}

/** Deletes a folder and atomically moves all of its words to unfiled. */
export async function deleteFolder(id: string): Promise<DeleteFolderResult> {
  const folderId = safeString(id)
  if (!folderId) throw new FolderNotFoundError(id)

  const database = await openDatabase()
  const transaction = database.transaction(
    [WORD_STORE, FOLDER_STORE],
    'readwrite',
  )
  const completion = transactionToPromise(transaction)
  const folderStore = transaction.objectStore(FOLDER_STORE)
  const wordStore = transaction.objectStore(WORD_STORE)

  try {
    const folderRequest = requestToPromise(
      folderStore.get(folderId) as IDBRequest<VocabularyFolder | undefined>,
    )
    const wordsRequest = requestToPromise(
      wordStore.index(FOLDER_ID_INDEX).getAll(IDBKeyRange.only(folderId)) as
        IDBRequest<WordEntry[]>,
    )
    const [folder, words] = await Promise.all([folderRequest, wordsRequest])

    if (!folder) {
      await abortTransaction(transaction)
      throw new FolderNotFoundError(folderId)
    }

    const now = new Date().toISOString()
    for (const word of words) {
      wordStore.put({ ...word, folderId: null, updatedAt: now })
    }
    folderStore.delete(folderId)
    await completion
    return { deleted: true, unfiledCount: words.length }
  } catch (error) {
    await completion.catch(() => undefined)
    throw error
  }
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
  const transaction = database.transaction(
    [WORD_STORE, FOLDER_STORE],
    'readwrite',
  )
  const completion = transactionToPromise(transaction)
  const store = transaction.objectStore(WORD_STORE)

  try {
    await assertFolderIdsExistInTransaction(
      transaction,
      added.flatMap((entry) => (entry.folderId ? [entry.folderId] : [])),
    )
    for (const entry of added) {
      store.add(entry)
    }
    await completion
  } catch (error) {
    if (error instanceof FolderNotFoundError) {
      await abortTransaction(transaction)
    }
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
        folderId:
          input.folderId === undefined ? existing.folderId : input.folderId,
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
  const transaction = database.transaction(
    [WORD_STORE, FOLDER_STORE],
    'readwrite',
  )
  const completion = transactionToPromise(transaction)

  try {
    await assertFolderExistsInTransaction(transaction, entry.folderId)
    transaction.objectStore(WORD_STORE).put(entry)
    await completion
  } catch (error) {
    if (error instanceof FolderNotFoundError) {
      await abortTransaction(transaction)
    }
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
  const transaction = database.transaction(
    [WORD_STORE, FOLDER_STORE],
    'readwrite',
  )
  const completion = transactionToPromise(transaction)
  transaction.objectStore(WORD_STORE).clear()
  transaction.objectStore(FOLDER_STORE).clear()
  await completion
}

interface FolderImportPlan {
  added: VocabularyFolder[]
  reused: VocabularyFolder[]
  idMap: Map<string, string>
}

function planFolderImport(
  inputs: readonly VocabularyFolderInput[],
  existingFolders: readonly VocabularyFolder[],
): FolderImportPlan {
  const added: VocabularyFolder[] = []
  const reused: VocabularyFolder[] = []
  const reusedIds = new Set<string>()
  const idMap = new Map<string, string>()
  const usedIds = new Set(existingFolders.map((folder) => folder.id))
  const foldersByName = new Map(
    existingFolders.map((folder) => [folder.normalizedName, folder]),
  )
  const existingIds = new Set(existingFolders.map((folder) => folder.id))

  for (const input of inputs) {
    const sourceId = safeString(input.id)
    const draft = prepareFolder(input)
    const matching = foldersByName.get(draft.normalizedName)

    if (matching) {
      if (sourceId) idMap.set(sourceId, matching.id)
      if (existingIds.has(matching.id) && !reusedIds.has(matching.id)) {
        reusedIds.add(matching.id)
        reused.push(matching)
      }
      continue
    }

    let id = sourceId
    if (!id || usedIds.has(id)) {
      do {
        id = makeId('folder')
      } while (usedIds.has(id))
    }

    const folder = prepareFolder(input, { id })
    usedIds.add(folder.id)
    foldersByName.set(folder.normalizedName, folder)
    added.push(folder)
    if (sourceId) idMap.set(sourceId, folder.id)
  }

  return { added, reused, idMap }
}

function remapImportedEntries(
  inputs: readonly WordEntryInput[],
  plan: FolderImportPlan,
  existingFolders: readonly VocabularyFolder[],
): WordEntryInput[] {
  const existingIds = new Set(existingFolders.map((folder) => folder.id))

  return inputs.map((input) => {
    const sourceFolderId = normalizeFolderId(input.folderId)
    if (sourceFolderId === null) return { ...input, folderId: null }

    const mappedFolderId =
      plan.idMap.get(sourceFolderId) ??
      (existingIds.has(sourceFolderId) ? sourceFolderId : undefined)
    if (!mappedFolderId) throw new FolderNotFoundError(sourceFolderId)
    return { ...input, folderId: mappedFolderId }
  })
}

/** Atomically replaces the vocabulary. Duplicate words in the input are skipped. */
export async function replaceAll(
  inputs: readonly WordEntryInput[],
  folderInputs: readonly VocabularyFolderInput[] = [],
): Promise<AddManyResult> {
  const folders: VocabularyFolder[] = []
  const usedFolderIds = new Set<string>()
  const usedFolderNames = new Set<string>()

  for (const input of folderInputs) {
    let id = safeString(input.id)
    if (!id || usedFolderIds.has(id)) {
      do {
        id = makeId('folder')
      } while (usedFolderIds.has(id))
    }

    const folder = prepareFolder(input, { id })
    if (usedFolderNames.has(folder.normalizedName)) {
      throw new DuplicateFolderError(folder.name)
    }
    usedFolderIds.add(folder.id)
    usedFolderNames.add(folder.normalizedName)
    folders.push(folder)
  }

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
    if (entry.folderId !== null && !usedFolderIds.has(entry.folderId)) {
      throw new FolderNotFoundError(entry.folderId)
    }
    usedWords.add(entry.normalizedWord)
    usedIds.add(entry.id)
    added.push(entry)
  }

  const database = await openDatabase()
  const transaction = database.transaction(
    [WORD_STORE, FOLDER_STORE],
    'readwrite',
  )
  const completion = transactionToPromise(transaction)
  const wordStore = transaction.objectStore(WORD_STORE)
  const folderStore = transaction.objectStore(FOLDER_STORE)
  wordStore.clear()
  folderStore.clear()
  for (const folder of folders) {
    folderStore.add(folder)
  }
  for (const entry of added) {
    wordStore.add(entry)
  }
  await completion

  return { added, duplicates }
}

async function mergeImportedEntries(
  inputs: readonly WordEntryInput[],
  foldersToAdd: readonly VocabularyFolder[],
): Promise<AddManyResult> {
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

  if (added.length === 0 && foldersToAdd.length === 0) {
    return { added, duplicates }
  }

  const database = await openDatabase()
  const transaction = database.transaction(
    [WORD_STORE, FOLDER_STORE],
    'readwrite',
  )
  const completion = transactionToPromise(transaction)
  const wordStore = transaction.objectStore(WORD_STORE)
  const folderStore = transaction.objectStore(FOLDER_STORE)

  for (const folder of foldersToAdd) folderStore.add(folder)
  for (const entry of added) wordStore.add(entry)
  await completion

  return { added, duplicates }
}

export async function importEntries(
  inputs: readonly WordEntryInput[],
  mode: ImportMode = 'merge',
  folderInputs: readonly VocabularyFolderInput[] = [],
): Promise<ImportResult> {
  if (folderInputs.length === 0) {
    const result =
      mode === 'replace' ? await replaceAll(inputs) : await addMany(inputs)
    return {
      ...result,
      mode,
      foldersAdded: [],
      foldersReused: [],
    }
  }

  const existingFolders = mode === 'merge' ? await getFolders() : []
  const plan = planFolderImport(folderInputs, existingFolders)
  const remappedEntries = remapImportedEntries(
    inputs,
    plan,
    existingFolders,
  )
  const result =
    mode === 'replace'
      ? await replaceAll(remappedEntries, plan.added)
      : await mergeImportedEntries(remappedEntries, plan.added)

  return {
    ...result,
    mode,
    foldersAdded: plan.added,
    foldersReused: plan.reused,
  }
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
