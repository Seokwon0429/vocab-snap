import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addMany,
  clear,
  closeDatabase,
  createFolder,
  deleteFolder,
  deleteMany,
  DuplicateFolderError,
  FolderNotFoundError,
  getAll,
  getFolders,
  importEntries,
  moveWordsToFolder,
  put,
  recordQuizResult,
  renameFolder,
} from './db'

const DATABASE_NAME = 'photo-english-vocabulary'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    })
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    })
  })
}

async function deleteTestDatabase(): Promise<void> {
  await closeDatabase()
  await requestResult(indexedDB.deleteDatabase(DATABASE_NAME))
}

describe('IndexedDB 단어장', () => {
  beforeEach(async () => {
    await clear()
  })

  it('단어를 저장하고 새로 읽으며 대소문자 중복을 건너뛴다', async () => {
    const result = await addMany([
      { word: 'Apple', meaning: '사과' },
      { word: 'apple', meaning: '중복' },
      { word: 'well-known', meaning: '잘 알려진' },
    ])

    expect(result.added).toHaveLength(2)
    expect(result.duplicates).toHaveLength(1)
    expect((await getAll()).map((entry) => entry.normalizedWord).sort()).toEqual([
      'apple',
      'well-known',
    ])
  })

  it('뜻 수정, 퀴즈 통계, 일괄 삭제를 유지한다', async () => {
    const [entry] = (await addMany([{ word: 'curious' }])).added
    await put({ ...entry, meaning: '호기심이 많은', partOfSpeech: '형용사' })
    const reviewed = await recordQuizResult(entry.id, 'known')

    expect(reviewed.meaning).toBe('호기심이 많은')
    expect(reviewed.quizStats).toMatchObject({ attempts: 1, knownCount: 1 })

    expect(await deleteMany([entry.id])).toBe(1)
    expect(await getAll()).toEqual([])
  })

  it('앱 내부 개수 제한 없이 많은 단어를 한 번에 저장한다', async () => {
    const inputs = Array.from({ length: 1_000 }, (_, index) => ({
      word: `vocabulary-${String.fromCharCode(
        97 + Math.floor(index / (26 * 26)),
        97 + Math.floor(index / 26) % 26,
        97 + index % 26,
      )}`,
    }))

    const result = await addMany(inputs)

    expect(result.added).toHaveLength(1_000)
    expect(result.duplicates).toEqual([])
    expect(await getAll()).toHaveLength(1_000)
  })

  it('폴더를 만들고 이름을 바꾸며 정규화된 중복 이름을 막는다', async () => {
    const folder = await createFolder('  학교   시험  ')

    expect(folder).toMatchObject({
      name: '학교 시험',
      normalizedName: '학교 시험',
    })
    await expect(createFolder('학교 시험')).rejects.toBeInstanceOf(
      DuplicateFolderError,
    )

    const renamed = await renameFolder(folder.id, '중간고사')
    expect(renamed).toMatchObject({ id: folder.id, name: '중간고사' })
    expect((await getFolders()).map((item) => item.name)).toEqual(['중간고사'])
  })

  it('여러 단어를 폴더로 이동하고 폴더 삭제 시 단어를 미분류로 보존한다', async () => {
    const folder = await createFolder('교과서 1과')
    const words = (await addMany([{ word: 'apple' }, { word: 'banana' }]))
      .added

    expect(await moveWordsToFolder(words.map((word) => word.id), folder.id)).toBe(
      2,
    )
    expect((await getAll()).every((word) => word.folderId === folder.id)).toBe(
      true,
    )

    const result = await deleteFolder(folder.id)
    expect(result).toEqual({ deleted: true, unfiledCount: 2 })
    expect(await getFolders()).toEqual([])
    expect((await getAll()).map((word) => word.folderId)).toEqual([null, null])
  })

  it('addMany와 put에서 존재하지 않는 폴더 참조를 거부한다', async () => {
    await expect(
      addMany([{ word: 'invalid-folder', folderId: 'missing-folder' }]),
    ).rejects.toBeInstanceOf(FolderNotFoundError)
    expect(await getAll()).toEqual([])

    const [entry] = (await addMany([{ word: 'safe-word' }])).added
    await expect(
      put({ ...entry, folderId: 'missing-folder' }),
    ).rejects.toBeInstanceOf(FolderNotFoundError)
    expect((await getAll())[0].folderId).toBeNull()
  })

  it('put에서 folderId를 생략하면 기존 폴더를 유지하고 null이면 미분류로 옮긴다', async () => {
    const folder = await createFolder('복습')
    const [entry] = (
      await addMany([{ word: 'preserve', folderId: folder.id }])
    ).added

    const edited = await put({ id: entry.id, word: entry.word, memo: 'updated' })
    expect(edited.folderId).toBe(folder.id)

    const unfiled = await put({ ...edited, folderId: null })
    expect(unfiled.folderId).toBeNull()
  })

  it('replace 가져오기는 기존 단어와 폴더를 함께 바꾸고 새 단어를 미분류로 둔다', async () => {
    const folder = await createFolder('기존 폴더')
    await addMany([{ word: 'old-word', folderId: folder.id }])

    const result = await importEntries([{ word: 'replacement' }], 'replace')

    expect(result.added).toHaveLength(1)
    expect(await getFolders()).toEqual([])
    expect(await getAll()).toMatchObject([
      { word: 'replacement', folderId: null },
    ])
  })

  it('폴더 포함 merge 가져오기는 같은 이름을 재사용하고 단어 참조를 재매핑한다', async () => {
    const existing = await createFolder('학교')
    const result = await importEntries(
      [
        { word: 'school', folderId: 'source-school' },
        { word: 'travel', folderId: 'source-travel' },
      ],
      'merge',
      [
        { id: 'source-school', name: ' 학교 ' },
        { id: 'source-travel', name: '여행' },
      ],
    )

    expect(result.foldersReused.map((folder) => folder.id)).toEqual([
      existing.id,
    ])
    expect(result.foldersAdded.map((folder) => folder.name)).toEqual(['여행'])
    const wordsByName = new Map(
      (await getAll()).map((word) => [word.word, word]),
    )
    expect(wordsByName.get('school')?.folderId).toBe(existing.id)
    expect(wordsByName.get('travel')?.folderId).toBe(
      result.foldersAdded[0].id,
    )
  })

  it('폴더 포함 replace 가져오기는 폴더와 단어를 함께 원자적으로 교체한다', async () => {
    await createFolder('지워질 폴더')
    await addMany([{ word: 'before' }])

    const result = await importEntries(
      [{ word: 'after', folderId: 'source-review' }],
      'replace',
      [{ id: 'source-review', name: '복습' }],
    )

    expect(result.foldersAdded).toHaveLength(1)
    expect((await getFolders()).map((folder) => folder.name)).toEqual(['복습'])
    expect(await getAll()).toMatchObject([
      { word: 'after', folderId: result.foldersAdded[0].id },
    ])
  })

  it('IndexedDB v1 단어를 손실 없이 v2 미분류 단어로 마이그레이션한다', async () => {
    await deleteTestDatabase()
    const createdAt = '2026-07-19T01:02:03.000Z'
    const updatedAt = '2026-07-19T04:05:06.000Z'
    const legacyEntry = {
      id: 'legacy-word-1',
      word: 'legacy',
      normalizedWord: 'legacy',
      meaning: '유산',
      partOfSpeech: '명사',
      memo: 'v1에서 저장됨',
      createdAt,
      updatedAt,
      quizStats: {
        attempts: 3,
        knownCount: 2,
        unknownCount: 1,
        lastResult: 'known',
        lastReviewedAt: updatedAt,
      },
    }

    const legacyOpen = indexedDB.open(DATABASE_NAME, 1)
    legacyOpen.addEventListener('upgradeneeded', () => {
      const store = legacyOpen.result.createObjectStore('words', {
        keyPath: 'id',
      })
      store.add(legacyEntry)
    })
    const legacyDatabase = await requestResult(legacyOpen)
    legacyDatabase.close()

    expect(await getAll()).toEqual([{ ...legacyEntry, folderId: null }])
    expect(await getFolders()).toEqual([])
  })
})
