import { describe, expect, it } from 'vitest'
import type { WordEntry } from '../types'
import {
  createCsvExport,
  createJsonExport,
  parseCsvImport,
  parseJsonImport,
} from './importExport'

const entry: WordEntry = {
  id: 'test-1',
  word: "don't",
  normalizedWord: "don't",
  meaning: '하지 않는다, 축약형',
  partOfSpeech: '동사',
  memo: 'He said, "don’t".\n두 번째 줄',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  quizStats: {
    attempts: 3,
    knownCount: 2,
    unknownCount: 1,
    lastResult: 'known',
    lastReviewedAt: '2026-07-20T01:00:00.000Z',
  },
}

describe('가져오기와 내보내기', () => {
  it('한국어와 줄바꿈이 있는 JSON을 왕복한다', () => {
    const parsed = parseJsonImport(createJsonExport([entry]))
    expect(parsed.rejectedCount).toBe(0)
    expect(parsed.entries[0]).toMatchObject({
      word: "don't",
      meaning: entry.meaning,
      memo: entry.memo,
    })
  })

  it('쉼표·따옴표·줄바꿈이 있는 CSV를 왕복한다', () => {
    const csv = createCsvExport([entry])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const parsed = parseCsvImport(csv)

    expect(parsed.rejectedCount).toBe(0)
    expect(parsed.entries[0]).toMatchObject({
      word: "don't",
      meaning: entry.meaning,
      memo: entry.memo,
    })
  })
})
