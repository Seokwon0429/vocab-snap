import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { addMany, clear, deleteMany, getAll, put, recordQuizResult } from './db'

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
})
