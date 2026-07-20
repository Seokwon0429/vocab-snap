import { describe, expect, it } from 'vitest'
import type { VocabularyFolder, WordEntry } from '../types'
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
  folderId: 'folder-1',
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

const folder: VocabularyFolder = {
  id: 'folder-1',
  name: '시험 대비',
  normalizedName: '시험 대비',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
}

describe('가져오기와 내보내기', () => {
  it('한국어와 줄바꿈이 있는 JSON을 왕복한다', () => {
    const parsed = parseJsonImport(createJsonExport([entry], [folder]))
    expect(parsed.rejectedCount).toBe(0)
    expect(parsed.entries[0]).toMatchObject({
      word: "don't",
      meaning: entry.meaning,
      memo: entry.memo,
      folderId: folder.id,
    })
    expect(parsed.folders).toEqual([expect.objectContaining({ id: folder.id, name: folder.name })])
  })

  it('쉼표·따옴표·줄바꿈이 있는 CSV를 왕복한다', () => {
    const csv = createCsvExport([entry], [folder])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const parsed = parseCsvImport(csv)

    expect(parsed.rejectedCount).toBe(0)
    expect(parsed.entries[0]).toMatchObject({
      word: "don't",
      meaning: entry.meaning,
      memo: entry.memo,
      folderId: folder.id,
    })
    expect(parsed.folders).toEqual([expect.objectContaining({ id: folder.id, name: folder.name })])
  })

  it('이전 JSON 백업은 폴더 없는 단어로 가져온다', () => {
    const legacy = JSON.stringify({ schemaVersion: 1, entries: [{ word: 'legacy' }] })
    const parsed = parseJsonImport(legacy)

    expect(parsed.folders).toEqual([])
    expect(parsed.entries[0]).toMatchObject({ word: 'legacy', folderId: null })
  })

  it('단어가 없는 빈 폴더도 JSON과 CSV에서 보존한다', () => {
    const json = parseJsonImport(createJsonExport([], [folder]))
    const csv = parseCsvImport(createCsvExport([], [folder]))

    expect(json.entries).toEqual([])
    expect(csv.entries).toEqual([])
    expect(json.folders[0]).toMatchObject({ id: folder.id, name: folder.name })
    expect(csv.folders[0]).toMatchObject({ id: folder.id, name: folder.name })
  })

  it('중복 폴더 이름을 합치고 단어의 폴더 참조를 보존한다', () => {
    const parsed = parseJsonImport(JSON.stringify({
      schemaVersion: 2,
      folders: [
        { id: 'first-folder', name: '복습' },
        { id: 'duplicate-folder', name: ' 복습 ' },
      ],
      entries: [{ word: 'review', folderId: 'duplicate-folder' }],
    }))

    expect(parsed.folders).toEqual([
      expect.objectContaining({ id: 'first-folder', name: '복습' }),
    ])
    expect(parsed.entries[0].folderId).toBe('first-folder')
  })

  it('CSV 수식 문자를 보호하고 다시 가져올 때 원문을 복원한다', () => {
    const riskyFolder = { ...folder, name: '@시험' }
    const riskyEntry = {
      ...entry,
      meaning: '=HYPERLINK("https://example.com")',
      memo: '+SUM(1,2)',
    }
    const csv = createCsvExport([riskyEntry], [riskyFolder])

    expect(csv).toContain("'=HYPERLINK")
    expect(csv).toContain("'+SUM")
    expect(csv).toContain("'@시험")
    const parsed = parseCsvImport(csv)
    expect(parsed.entries[0]).toMatchObject({
      meaning: riskyEntry.meaning,
      memo: riskyEntry.memo,
    })
    expect(parsed.folders[0].name).toBe(riskyFolder.name)
  })
})
