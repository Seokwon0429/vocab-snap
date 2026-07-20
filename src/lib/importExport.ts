import type {
  ImportIssue,
  ImportParseResult,
  VocabularyExport,
  WordEntry,
  WordEntryInput,
  WordQuizStats,
} from '../types'
import { normalizeWord } from './db'

export type ExportFormat = 'json' | 'csv'
export type ImportFormat = ExportFormat

export interface ExportArtifact {
  blob: Blob
  filename: string
}

export const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024

const CSV_HEADERS = [
  'id',
  'word',
  'meaning',
  'partOfSpeech',
  'memo',
  'createdAt',
  'updatedAt',
  'attempts',
  'knownCount',
  'unknownCount',
  'lastResult',
  'lastReviewedAt',
] as const

type UnknownRecord = Record<string, unknown>

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportFormatError'
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function createJsonExport(entries: readonly WordEntry[]): string {
  const payload: VocabularyExport = {
    app: '사진 영어 단어장',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    entries: [...entries],
  }

  return JSON.stringify(payload, null, 2)
}

/** UTF-8 CSV with a BOM so Korean text opens correctly in spreadsheet apps. */
export function createCsvExport(entries: readonly WordEntry[]): string {
  const rows = entries.map((entry) => [
    entry.id,
    entry.word,
    entry.meaning,
    entry.partOfSpeech,
    entry.memo,
    entry.createdAt,
    entry.updatedAt,
    entry.quizStats.attempts,
    entry.quizStats.knownCount,
    entry.quizStats.unknownCount,
    entry.quizStats.lastResult ?? '',
    entry.quizStats.lastReviewedAt ?? '',
  ])

  return `\uFEFF${[CSV_HEADERS, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n')}`
}

export function createExportArtifact(
  entries: readonly WordEntry[],
  format: ExportFormat,
): ExportArtifact {
  const date = new Date().toISOString().slice(0, 10)
  const content =
    format === 'json' ? createJsonExport(entries) : createCsvExport(entries)
  const mimeType =
    format === 'json'
      ? 'application/json;charset=utf-8'
      : 'text/csv;charset=utf-8'

  return {
    blob: new Blob([content], { type: mimeType }),
    filename: `english-vocabulary-${date}.${format}`,
  }
}

/** Starts a browser download without uploading any vocabulary data. */
export function downloadExport(
  entries: readonly WordEntry[],
  format: ExportFormat,
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('파일 다운로드는 브라우저에서만 사용할 수 있습니다.')
  }

  const artifact = createExportArtifact(entries, format)
  const url = URL.createObjectURL(artifact.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = artifact.filename
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s_\-()]/g, '')
}

const FIELD_ALIASES = {
  id: ['id', '아이디'],
  word: ['word', '단어', '영단어', '영어단어'],
  meaning: ['meaning', '뜻', '한국어뜻', '의미'],
  partOfSpeech: ['partofspeech', 'pos', '품사'],
  memo: ['memo', 'note', 'notes', '메모', '노트'],
  createdAt: ['createdat', 'created', '생성일', '등록일'],
  updatedAt: ['updatedat', 'updated', '수정일'],
  attempts: ['attempts', 'attempt', '학습횟수', '시도횟수'],
  knownCount: ['knowncount', 'known', '암', '아는횟수', '정답횟수'],
  unknownCount: [
    'unknowncount',
    'unknown',
    '모름',
    '모르는횟수',
    '오답횟수',
  ],
  lastResult: ['lastresult', '최근결과'],
  lastReviewedAt: ['lastreviewedat', 'lastreviewed', '최근학습일'],
} as const

function getAliasedField(
  record: UnknownRecord,
  aliases: readonly string[],
): unknown {
  const aliasSet = new Set(aliases.map(normalizeHeader))
  const key = Object.keys(record).find((candidate) =>
    aliasSet.has(normalizeHeader(candidate)),
  )
  return key === undefined ? undefined : record[key]
}

function optionalText(
  value: unknown,
  label: string,
  row: number,
  issues: ImportIssue[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'string') {
    return value.trim()
  }

  issues.push({
    row,
    severity: 'warning',
    message: `${label} 값이 문자열이 아니어서 텍스트로 변환했습니다.`,
  })
  return String(value).trim()
}

function optionalDate(
  value: unknown,
  label: string,
  row: number,
  issues: ImportIssue[],
): string | undefined {
  const text = optionalText(value, label, row, issues)
  if (!text) {
    return undefined
  }
  if (Number.isNaN(Date.parse(text))) {
    issues.push({
      row,
      severity: 'warning',
      message: `${label} 날짜 형식을 읽을 수 없어 현재 시각을 사용합니다.`,
    })
    return undefined
  }
  return new Date(text).toISOString()
}

function optionalCount(
  value: unknown,
  label: string,
  row: number,
  issues: ImportIssue[],
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(parsed) || parsed < 0) {
    issues.push({
      row,
      severity: 'warning',
      message: `${label} 값이 올바른 0 이상의 숫자가 아니어서 제외했습니다.`,
    })
    return undefined
  }
  return Math.trunc(parsed)
}

function normalizeImportedWord(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const word = value
    .trim()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLocaleLowerCase('en-US')

  return /^[a-z]+(?:['-][a-z]+)*$/.test(word) ? word : null
}

function validateEntry(
  raw: unknown,
  row: number,
  issues: ImportIssue[],
): WordEntryInput | null {
  if (!isRecord(raw)) {
    issues.push({
      row,
      severity: 'error',
      message: '단어 항목이 객체 형식이 아닙니다.',
    })
    return null
  }

  const rawWord = getAliasedField(raw, FIELD_ALIASES.word)
  const word = normalizeImportedWord(rawWord)
  if (!word) {
    issues.push({
      row,
      severity: 'error',
      message:
        '영어 단어가 비어 있거나 올바르지 않습니다. 영문자와 단어 안의 아포스트로피·하이픈만 사용할 수 있습니다.',
    })
    return null
  }

  const nestedQuizStats = getAliasedField(raw, ['quizStats', '학습통계'])
  const quizRecord = isRecord(nestedQuizStats) ? nestedQuizStats : raw
  const knownCount = optionalCount(
    getAliasedField(quizRecord, FIELD_ALIASES.knownCount),
    '아는 횟수',
    row,
    issues,
  )
  const unknownCount = optionalCount(
    getAliasedField(quizRecord, FIELD_ALIASES.unknownCount),
    '모르는 횟수',
    row,
    issues,
  )
  const attempts = optionalCount(
    getAliasedField(quizRecord, FIELD_ALIASES.attempts),
    '학습 횟수',
    row,
    issues,
  )
  const rawLastResult = optionalText(
    getAliasedField(quizRecord, FIELD_ALIASES.lastResult),
    '최근 학습 결과',
    row,
    issues,
  )
  const lastResult =
    rawLastResult === 'known' || rawLastResult === 'unknown'
      ? rawLastResult
      : undefined

  if (rawLastResult && !lastResult) {
    issues.push({
      row,
      severity: 'warning',
      message: '최근 학습 결과는 known 또는 unknown만 사용할 수 있어 제외했습니다.',
    })
  }

  const quizStats: Partial<WordQuizStats> = {
    attempts,
    knownCount,
    unknownCount,
    lastResult,
    lastReviewedAt: optionalDate(
      getAliasedField(quizRecord, FIELD_ALIASES.lastReviewedAt),
      '최근 학습일',
      row,
      issues,
    ),
  }

  return {
    id: optionalText(getAliasedField(raw, FIELD_ALIASES.id), 'ID', row, issues),
    word,
    meaning: optionalText(
      getAliasedField(raw, FIELD_ALIASES.meaning),
      '뜻',
      row,
      issues,
    ),
    partOfSpeech: optionalText(
      getAliasedField(raw, FIELD_ALIASES.partOfSpeech),
      '품사',
      row,
      issues,
    ),
    memo: optionalText(
      getAliasedField(raw, FIELD_ALIASES.memo),
      '메모',
      row,
      issues,
    ),
    createdAt: optionalDate(
      getAliasedField(raw, FIELD_ALIASES.createdAt),
      '생성일',
      row,
      issues,
    ),
    updatedAt: optionalDate(
      getAliasedField(raw, FIELD_ALIASES.updatedAt),
      '수정일',
      row,
      issues,
    ),
    quizStats,
  }
}

function validateEntries(rawEntries: readonly unknown[]): ImportParseResult {
  const entries: WordEntryInput[] = []
  const issues: ImportIssue[] = []
  const seen = new Set<string>()
  let rejectedCount = 0

  rawEntries.forEach((raw, index) => {
    const row = index + 1
    const entry = validateEntry(raw, row, issues)
    if (!entry) {
      rejectedCount += 1
      return
    }

    const key = normalizeWord(entry.word)
    if (seen.has(key)) {
      issues.push({
        row,
        severity: 'warning',
        message: `파일 안에 중복된 단어 "${entry.word}"가 있어 한 번만 가져옵니다.`,
      })
      rejectedCount += 1
      return
    }

    seen.add(key)
    entries.push(entry)
  })

  return { entries, issues, rejectedCount }
}

export function parseJsonImport(text: string): ImportParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new ImportFormatError('JSON 파일 형식이 올바르지 않습니다.')
  }

  let rawEntries: unknown
  const topLevelIssues: ImportIssue[] = []
  if (Array.isArray(parsed)) {
    rawEntries = parsed
  } else if (isRecord(parsed)) {
    rawEntries = parsed.entries ?? parsed.words ?? parsed.vocabulary
    if (
      typeof parsed.schemaVersion === 'number' &&
      parsed.schemaVersion > 1
    ) {
      topLevelIssues.push({
        row: 1,
        severity: 'warning',
        message:
          '더 최신 버전에서 만든 백업입니다. 알 수 없는 필드는 제외하고 가져옵니다.',
      })
    }
  }

  if (!Array.isArray(rawEntries)) {
    throw new ImportFormatError(
      'JSON에는 단어 배열 또는 entries 배열이 있어야 합니다.',
    )
  }

  const result = validateEntries(rawEntries)
  result.issues.unshift(...topLevelIssues)
  return result
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const source = text.replace(/^\uFEFF/, '')

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]

    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += character
      }
      continue
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') {
        index += 1
      }
      row.push(field)
      if (row.some((cell) => cell.trim() !== '')) {
        rows.push(row)
      }
      row = []
      field = ''
    } else {
      field += character
    }
  }

  if (inQuotes) {
    throw new ImportFormatError('CSV의 따옴표가 닫히지 않았습니다.')
  }

  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) {
    rows.push(row)
  }
  return rows
}

export function parseCsvImport(text: string): ImportParseResult {
  const rows = parseCsvRows(text)
  if (rows.length === 0) {
    throw new ImportFormatError('CSV 파일이 비어 있습니다.')
  }

  const headers = rows[0].map(normalizeHeader)
  const hasWordHeader = headers.some((header) =>
    FIELD_ALIASES.word.map(normalizeHeader).includes(header),
  )
  if (!hasWordHeader) {
    throw new ImportFormatError(
      'CSV 첫 줄에 word 또는 단어 열이 있어야 합니다.',
    )
  }

  const rawEntries = rows.slice(1).map((cells) =>
    Object.fromEntries(
      headers.map((header, index) => [header, cells[index] ?? '']),
    ),
  )
  return validateEntries(rawEntries)
}

export function parseImportText(
  text: string,
  format: ImportFormat,
): ImportParseResult {
  return format === 'json' ? parseJsonImport(text) : parseCsvImport(text)
}

function detectImportFormat(file: File, text: string): ImportFormat {
  const extension = file.name.split('.').pop()?.toLocaleLowerCase('en-US')
  if (extension === 'json' || file.type.includes('json')) {
    return 'json'
  }
  if (extension === 'csv' || file.type.includes('csv')) {
    return 'csv'
  }

  const firstCharacter = text.replace(/^\uFEFF/, '').trimStart()[0]
  if (firstCharacter === '{' || firstCharacter === '[') {
    return 'json'
  }
  if (text.includes(',')) {
    return 'csv'
  }

  throw new ImportFormatError('JSON 또는 CSV 파일만 가져올 수 있습니다.')
}

export async function parseImportFile(file: File): Promise<ImportParseResult> {
  if (file.size > MAX_IMPORT_FILE_SIZE) {
    throw new ImportFormatError('가져오기 파일은 10MB 이하여야 합니다.')
  }
  if (file.size === 0) {
    throw new ImportFormatError('가져오기 파일이 비어 있습니다.')
  }

  const text = await file.text()
  return parseImportText(text, detectImportFormat(file, text))
}

