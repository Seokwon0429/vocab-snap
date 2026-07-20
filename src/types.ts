/** A learner's judgement after revealing a quiz card. */
export type QuizResult = 'known' | 'unknown'

/** Persistent review history for one word. */
export interface WordQuizStats {
  attempts: number
  knownCount: number
  unknownCount: number
  lastResult: QuizResult | null
  lastReviewedAt: string | null
}

/** A word stored in IndexedDB. Dates are ISO-8601 strings. */
export interface WordEntry {
  id: string
  word: string
  /** Case-insensitive key used to prevent duplicate words. */
  normalizedWord: string
  meaning: string
  partOfSpeech: string
  memo: string
  /** Folder containing this word. `null` represents the built-in unfiled view. */
  folderId: string | null
  createdAt: string
  updatedAt: string
  quizStats: WordQuizStats
}

/** Shape accepted by the persistence layer when creating/importing a word. */
export interface WordEntryInput {
  id?: string
  word: string
  normalizedWord?: string
  meaning?: string
  partOfSpeech?: string
  memo?: string
  /** Omit to preserve an existing folder; use `null` to move to unfiled. */
  folderId?: string | null
  createdAt?: string
  updatedAt?: string
  quizStats?: Partial<WordQuizStats>
}

/** A user-created vocabulary folder stored in IndexedDB. */
export interface VocabularyFolder {
  id: string
  name: string
  /** Unicode-normalized, case-insensitive key used to prevent duplicates. */
  normalizedName: string
  createdAt: string
  updatedAt: string
}

/** Shape accepted when a folder is created or restored from a backup. */
export interface VocabularyFolderInput {
  id?: string
  name: string
  createdAt?: string
  updatedAt?: string
}

export interface DeleteFolderResult {
  deleted: boolean
  unfiledCount: number
}

/** Aggregate statistics suitable for the quiz summary UI. */
export interface QuizStats {
  totalWords: number
  studiedWords: number
  totalAttempts: number
  knownCount: number
  unknownCount: number
  /** Percentage from 0 to 100. */
  accuracy: number
}

export type ImportMode = 'merge' | 'replace'

export interface AddManyResult {
  added: WordEntry[]
  duplicates: WordEntryInput[]
}

export interface ImportResult extends AddManyResult {
  mode: ImportMode
  foldersAdded: VocabularyFolder[]
  foldersReused: VocabularyFolder[]
}

export type ImportIssueSeverity = 'warning' | 'error'

export interface ImportIssue {
  /** One-based data row/item number. */
  row: number
  severity: ImportIssueSeverity
  message: string
}

export interface ImportParseResult {
  entries: WordEntryInput[]
  folders: VocabularyFolderInput[]
  issues: ImportIssue[]
  rejectedCount: number
  rejectedFolderCount: number
}

export interface VocabularyExport {
  app: '사진 영어 단어장'
  schemaVersion: 2
  exportedAt: string
  folders: VocabularyFolder[]
  entries: WordEntry[]
}
