import type { VocabularyFolder, WordEntry } from '../types'

const DB_NAME = 'wordlens-offline-study'
const DB_VERSION = 1
const SNAPSHOT_STORE = 'snapshots'
const SNAPSHOT_KEY = 'latest'

export interface OfflineStudySnapshot {
  version: 1
  ownerId: string
  ownerUsername: string
  savedAt: string
  entries: WordEntry[]
  folders: VocabularyFolder[]
}

interface OfflineStudySnapshotInput {
  ownerId: string
  ownerUsername: string
  entries: readonly WordEntry[]
  folders: readonly VocabularyFolder[]
}

let databasePromise: Promise<IDBDatabase> | null = null

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    })
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('오프라인 학습본 요청에 실패했습니다.')),
      { once: true },
    )
  })
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('오프라인 학습본 저장이 취소되었습니다.')),
      { once: true },
    )
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('오프라인 학습본 저장에 실패했습니다.')),
      { once: true },
    )
  })
}

function openDatabase(): Promise<IDBDatabase> {
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(new Error('이 브라우저에서는 오프라인 학습본을 저장할 수 없습니다.'))
  }

  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.addEventListener('upgradeneeded', () => {
      if (!request.result.objectStoreNames.contains(SNAPSHOT_STORE)) {
        request.result.createObjectStore(SNAPSHOT_STORE)
      }
    })
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    })
    request.addEventListener(
      'error',
      () => {
        databasePromise = null
        reject(request.error ?? new Error('오프라인 학습본 저장소를 열지 못했습니다.'))
      },
      { once: true },
    )
  })

  return databasePromise
}

function isSnapshot(value: unknown): value is OfflineStudySnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<OfflineStudySnapshot>
  return (
    snapshot.version === 1 &&
    typeof snapshot.ownerId === 'string' &&
    typeof snapshot.ownerUsername === 'string' &&
    typeof snapshot.savedAt === 'string' &&
    !Number.isNaN(Date.parse(snapshot.savedAt)) &&
    Array.isArray(snapshot.entries) &&
    Array.isArray(snapshot.folders)
  )
}

export async function getOfflineStudySnapshot(): Promise<OfflineStudySnapshot | null> {
  const database = await openDatabase()
  const transaction = database.transaction(SNAPSHOT_STORE, 'readonly')
  const stored = await requestToPromise(
    transaction.objectStore(SNAPSHOT_STORE).get(SNAPSHOT_KEY),
  )
  return isSnapshot(stored) ? stored : null
}

export async function saveOfflineStudySnapshot(
  input: OfflineStudySnapshotInput,
): Promise<OfflineStudySnapshot> {
  const snapshot: OfflineStudySnapshot = {
    version: 1,
    ownerId: input.ownerId,
    ownerUsername: input.ownerUsername,
    savedAt: new Date().toISOString(),
    entries: [...input.entries],
    folders: [...input.folders],
  }
  const database = await openDatabase()
  const transaction = database.transaction(SNAPSHOT_STORE, 'readwrite')
  transaction.objectStore(SNAPSHOT_STORE).put(snapshot, SNAPSHOT_KEY)
  await transactionToPromise(transaction)
  return snapshot
}

export async function clearOfflineStudySnapshot(): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(SNAPSHOT_STORE, 'readwrite')
  transaction.objectStore(SNAPSHOT_STORE).delete(SNAPSHOT_KEY)
  await transactionToPromise(transaction)
}
