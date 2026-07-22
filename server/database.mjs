import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { conflict, limitExceeded, notFound } from './errors.mjs'
import {
  normalizeFolderName,
  normalizeWord,
  prepareFolderInput,
  prepareWordInput,
  uniqueIds,
} from './validation.mjs'

function mapUser(row) {
  return row
    ? {
        id: row.id,
        username: row.username,
        role: row.role === 'admin' ? 'admin' : 'user',
        createdAt: row.created_at,
      }
    : null
}

function mapFolder(row) {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapWord(row) {
  return {
    id: row.id,
    word: row.word,
    normalizedWord: row.normalized_word,
    meaning: row.meaning,
    partOfSpeech: row.part_of_speech,
    memo: row.memo,
    folderId: row.folder_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    quizStats: {
      attempts: row.quiz_attempts,
      knownCount: row.quiz_known_count,
      unknownCount: row.quiz_unknown_count,
      lastResult: row.quiz_last_result,
      lastReviewedAt: row.quiz_last_reviewed_at,
    },
  }
}

function isUniqueConstraint(error) {
  return error && typeof error === 'object'
    && String(error.code ?? '').startsWith('ERR_SQLITE_CONSTRAINT')
}

export class WordLensDatabase {
  constructor(databasePath, options = {}) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.sqlite = new DatabaseSync(databasePath)
    this.sqlite.exec('PRAGMA foreign_keys = ON')
    this.sqlite.exec('PRAGMA busy_timeout = 5000')
    if (databasePath !== ':memory:') this.sqlite.exec('PRAGMA journal_mode = WAL')
    const maxDatabaseBytes = Number(options.maxDatabaseBytes)
    if (Number.isFinite(maxDatabaseBytes) && maxDatabaseBytes > 0) {
      const pageSize = Number(this.sqlite.prepare('PRAGMA page_size').get().page_size)
      const maxPageCount = Math.max(
        1,
        Math.min(0x7fff_fffe, Math.floor(maxDatabaseBytes / pageSize)),
      )
      this.sqlite.exec(`PRAGMA max_page_count = ${maxPageCount}`)
    }
    this.#migrate()
    this.#prepare()
  }

  #migrate() {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          username_key TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, normalized_name)
        );
        CREATE INDEX IF NOT EXISTS folders_user_id ON folders(user_id);
        CREATE TABLE IF NOT EXISTS words (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          word TEXT NOT NULL,
          normalized_word TEXT NOT NULL,
          meaning TEXT NOT NULL DEFAULT '',
          part_of_speech TEXT NOT NULL DEFAULT '',
          memo TEXT NOT NULL DEFAULT '',
          folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          quiz_attempts INTEGER NOT NULL DEFAULT 0,
          quiz_known_count INTEGER NOT NULL DEFAULT 0,
          quiz_unknown_count INTEGER NOT NULL DEFAULT 0,
          quiz_last_result TEXT CHECK(quiz_last_result IN ('known', 'unknown')),
          quiz_last_reviewed_at TEXT,
          UNIQUE(user_id, normalized_word)
        );
        CREATE INDEX IF NOT EXISTS words_user_id ON words(user_id);
        CREATE INDEX IF NOT EXISTS words_user_folder ON words(user_id, folder_id);
      `)

      const userColumns = this.sqlite.prepare('PRAGMA table_info(users)').all()
      if (!userColumns.some((column) => column.name === 'role')) {
        this.sqlite.exec(`
          ALTER TABLE users
          ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
          CHECK(role IN ('user', 'admin'))
        `)
      }
      this.sqlite.exec('COMMIT')
    } catch (error) {
      try {
        this.sqlite.exec('ROLLBACK')
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error
    }
  }

  #prepare() {
    this.statements = {
      insertUser: this.sqlite.prepare(
        'INSERT INTO users (id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      ),
      findUserByKey: this.sqlite.prepare(
        'SELECT * FROM users WHERE username_key = ?',
      ),
      findUserById: this.sqlite.prepare('SELECT * FROM users WHERE id = ?'),
      countUsers: this.sqlite.prepare('SELECT COUNT(*) AS count FROM users'),
      updateUserRoleById: this.sqlite.prepare(
        'UPDATE users SET role = ? WHERE id = ?',
      ),
      getAdminTotals: this.sqlite.prepare(`
        SELECT
          (SELECT COUNT(*) FROM users) AS user_count,
          (SELECT COUNT(*) FROM folders) AS folder_count,
          (SELECT COUNT(*) FROM words) AS word_count
      `),
      getAdminUsers: this.sqlite.prepare(`
        SELECT
          users.id AS user_id,
          users.username,
          users.created_at,
          (SELECT COUNT(*) FROM folders WHERE folders.user_id = users.id) AS folder_count,
          (SELECT COUNT(*) FROM words WHERE words.user_id = users.id) AS word_count
        FROM users
        ORDER BY users.created_at ASC, users.id ASC
      `),
      insertSession: this.sqlite.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ),
      findSessionUser: this.sqlite.prepare(`
        SELECT users.* FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > ?
      `),
      deleteSession: this.sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      deleteExpiredSessions: this.sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      getFolders: this.sqlite.prepare(`
        SELECT * FROM folders WHERE user_id = ?
        ORDER BY normalized_name ASC, created_at ASC
      `),
      countFolders: this.sqlite.prepare('SELECT COUNT(*) AS count FROM folders WHERE user_id = ?'),
      countWords: this.sqlite.prepare('SELECT COUNT(*) AS count FROM words WHERE user_id = ?'),
      getWords: this.sqlite.prepare(`
        SELECT * FROM words WHERE user_id = ?
        ORDER BY created_at DESC, normalized_word ASC
      `),
      getFolder: this.sqlite.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?'),
      getFolderByName: this.sqlite.prepare(
        'SELECT * FROM folders WHERE user_id = ? AND normalized_name = ?',
      ),
      getWord: this.sqlite.prepare('SELECT * FROM words WHERE id = ? AND user_id = ?'),
      getWordByNormalized: this.sqlite.prepare(
        'SELECT * FROM words WHERE user_id = ? AND normalized_word = ?',
      ),
      idExists: this.sqlite.prepare(`
        SELECT 1 AS found FROM (
          SELECT id FROM users WHERE id = ?
          UNION ALL SELECT id FROM folders WHERE id = ?
          UNION ALL SELECT id FROM words WHERE id = ?
        ) LIMIT 1
      `),
      insertFolder: this.sqlite.prepare(`
        INSERT INTO folders (id, user_id, name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      updateFolder: this.sqlite.prepare(`
        UPDATE folders SET name = ?, normalized_name = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `),
      deleteFolder: this.sqlite.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?'),
      countFolderWords: this.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM words WHERE user_id = ? AND folder_id = ?',
      ),
      unfileFolderWords: this.sqlite.prepare(`
        UPDATE words SET folder_id = NULL, updated_at = ? WHERE user_id = ? AND folder_id = ?
      `),
      insertWord: this.sqlite.prepare(`
        INSERT INTO words (
          id, user_id, word, normalized_word, meaning, part_of_speech, memo,
          folder_id, created_at, updated_at, quiz_attempts, quiz_known_count,
          quiz_unknown_count, quiz_last_result, quiz_last_reviewed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateWord: this.sqlite.prepare(`
        UPDATE words SET word = ?, normalized_word = ?, meaning = ?,
          part_of_speech = ?, memo = ?, folder_id = ?, updated_at = ?,
          quiz_attempts = ?, quiz_known_count = ?, quiz_unknown_count = ?,
          quiz_last_result = ?, quiz_last_reviewed_at = ?
        WHERE id = ? AND user_id = ?
      `),
      moveWord: this.sqlite.prepare(`
        UPDATE words SET folder_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND folder_id IS NOT ?
      `),
      deleteWord: this.sqlite.prepare('DELETE FROM words WHERE id = ? AND user_id = ?'),
      deleteUserWords: this.sqlite.prepare('DELETE FROM words WHERE user_id = ?'),
      deleteUserFolders: this.sqlite.prepare('DELETE FROM folders WHERE user_id = ?'),
      updateQuiz: this.sqlite.prepare(`
        UPDATE words SET quiz_attempts = ?, quiz_known_count = ?, quiz_unknown_count = ?,
          quiz_last_result = ?, quiz_last_reviewed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `),
    }
  }

  transaction(operation) {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.sqlite.exec('COMMIT')
      return result
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  createUser({ id, username, usernameKey, passwordHash, createdAt }) {
    try {
      this.statements.insertUser.run(id, username, usernameKey, passwordHash, createdAt)
      return mapUser(this.statements.findUserById.get(id))
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw conflict('USERNAME_TAKEN', '이미 사용 중인 아이디입니다.')
      }
      throw error
    }
  }

  countUsers() {
    return Number(this.statements.countUsers.get().count)
  }

  setUserRoleById(userId, role) {
    const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : ''
    if (normalizedRole !== 'user' && normalizedRole !== 'admin') {
      throw new TypeError('Role must be either user or admin.')
    }

    const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
    if (!normalizedUserId) throw new TypeError('User ID is required.')

    return this.transaction(() => {
      const result = this.statements.updateUserRoleById.run(normalizedRole, normalizedUserId)
      if (Number(result.changes) === 0) {
        throw notFound('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.')
      }
      return mapUser(this.statements.findUserById.get(normalizedUserId))
    })
  }

  getAdminStats() {
    const totals = this.statements.getAdminTotals.get()
    return {
      summary: {
        totalUserCount: Number(totals.user_count),
        totalFolderCount: Number(totals.folder_count),
        totalWordCount: Number(totals.word_count),
      },
      users: this.statements.getAdminUsers.all().map((row) => ({
        userId: row.user_id,
        username: row.username,
        createdAt: row.created_at,
        folderCount: Number(row.folder_count),
        wordCount: Number(row.word_count),
      })),
    }
  }

  findUserForLogin(usernameKey) {
    return this.statements.findUserByKey.get(usernameKey) ?? null
  }

  createSession({ tokenHash, userId, createdAt, expiresAt }) {
    this.statements.insertSession.run(tokenHash, userId, createdAt, expiresAt)
  }

  findUserBySession(tokenHash, now) {
    return mapUser(this.statements.findSessionUser.get(tokenHash, now))
  }

  deleteSession(tokenHash) {
    this.statements.deleteSession.run(tokenHash)
  }

  deleteExpiredSessions(now) {
    this.statements.deleteExpiredSessions.run(now)
  }

  getVocabulary(userId) {
    return {
      folders: this.statements.getFolders.all(userId).map(mapFolder),
      entries: this.statements.getWords.all(userId).map(mapWord),
    }
  }

  #availableId(preferredId) {
    let id = preferredId
    while (this.statements.idExists.get(id, id, id)) {
      id = randomUUID()
    }
    return id
  }

  #assertFolder(userId, folderId) {
    if (folderId === null) return
    if (!this.statements.getFolder.get(folderId, userId)) {
      throw notFound('FOLDER_NOT_FOUND', '폴더를 찾을 수 없습니다.')
    }
  }

  #insertFolder(userId, input, options = {}) {
    const folder = prepareFolderInput(input, options)
    folder.id = this.#availableId(folder.id)
    try {
      this.statements.insertFolder.run(
        folder.id,
        userId,
        folder.name,
        folder.normalizedName,
        folder.createdAt,
        folder.updatedAt,
      )
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw conflict('DUPLICATE_FOLDER', `같은 이름의 폴더가 이미 있습니다: ${folder.name}`)
      }
      throw error
    }
    return folder
  }

  createFolder(userId, name, maxFolders = Number.POSITIVE_INFINITY) {
    if (Number(this.statements.countFolders.get(userId).count) >= maxFolders) {
      throw limitExceeded(`폴더는 계정당 최대 ${maxFolders}개까지 만들 수 있습니다.`)
    }
    return this.#insertFolder(userId, { name })
  }

  renameFolder(userId, id, name) {
    const existingRow = this.statements.getFolder.get(id, userId)
    if (!existingRow) throw notFound('FOLDER_NOT_FOUND', '폴더를 찾을 수 없습니다.')
    const folder = prepareFolderInput(
      { ...mapFolder(existingRow), name, updatedAt: new Date().toISOString() },
      { id, createdAt: existingRow.created_at },
    )
    try {
      this.statements.updateFolder.run(
        folder.name,
        folder.normalizedName,
        folder.updatedAt,
        id,
        userId,
      )
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw conflict('DUPLICATE_FOLDER', `같은 이름의 폴더가 이미 있습니다: ${folder.name}`)
      }
      throw error
    }
    return folder
  }

  removeFolder(userId, id) {
    const existing = this.statements.getFolder.get(id, userId)
    if (!existing) throw notFound('FOLDER_NOT_FOUND', '폴더를 찾을 수 없습니다.')
    return this.transaction(() => {
      const unfiledCount = Number(
        this.statements.countFolderWords.get(userId, id).count,
      )
      const now = new Date().toISOString()
      this.statements.unfileFolderWords.run(now, userId, id)
      this.statements.deleteFolder.run(id, userId)
      return { deleted: true, unfiledCount }
    })
  }

  #insertWord(userId, input, options = {}) {
    const entry = prepareWordInput(input, options)
    entry.id = this.#availableId(entry.id)
    this.#assertFolder(userId, entry.folderId)
    try {
      this.statements.insertWord.run(
        entry.id,
        userId,
        entry.word,
        entry.normalizedWord,
        entry.meaning,
        entry.partOfSpeech,
        entry.memo,
        entry.folderId,
        entry.createdAt,
        entry.updatedAt,
        entry.quizStats.attempts,
        entry.quizStats.knownCount,
        entry.quizStats.unknownCount,
        entry.quizStats.lastResult,
        entry.quizStats.lastReviewedAt,
      )
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw conflict('DUPLICATE_WORD', `이미 단어장에 있는 단어입니다: ${entry.word}`)
      }
      throw error
    }
    return entry
  }

  addWords(userId, inputs, maxWords = Number.POSITIVE_INFINITY) {
    const values = Array.isArray(inputs) ? inputs : []
    const added = []
    const duplicates = []
    const seen = new Set(
      this.statements.getWords.all(userId).map((row) => row.normalized_word),
    )

    return this.transaction(() => {
      for (const input of values) {
        const normalized = normalizeWord(input?.word)
        if (seen.has(normalized)) {
          duplicates.push(input)
          continue
        }
        if (seen.size >= maxWords) {
          throw limitExceeded(`단어는 계정당 최대 ${maxWords}개까지 저장할 수 있습니다.`)
        }
        const entry = this.#insertWord(userId, input)
        seen.add(entry.normalizedWord)
        added.push(entry)
      }
      return { added, duplicates }
    })
  }

  putWord(userId, input, maxWords = Number.POSITIVE_INFINITY) {
    const requestedId = typeof input?.id === 'string' ? input.id.trim() : ''
    const existingRow = requestedId
      ? this.statements.getWord.get(requestedId, userId)
      : null
    if (!existingRow) {
      if (Number(this.statements.countWords.get(userId).count) >= maxWords) {
        throw limitExceeded(`단어는 계정당 최대 ${maxWords}개까지 저장할 수 있습니다.`)
      }
      return this.#insertWord(userId, input)
    }

    const existing = mapWord(existingRow)
    const merged = {
      ...existing,
      ...input,
      folderId: input.folderId === undefined ? existing.folderId : input.folderId,
      quizStats: { ...existing.quizStats, ...(input.quizStats ?? {}) },
      updatedAt: new Date().toISOString(),
    }
    const entry = prepareWordInput(merged, {
      id: existing.id,
      createdAt: existing.createdAt,
    })
    entry.updatedAt = new Date().toISOString()
    this.#assertFolder(userId, entry.folderId)

    const duplicate = this.statements.getWordByNormalized.get(userId, entry.normalizedWord)
    if (duplicate && duplicate.id !== entry.id) {
      throw conflict('DUPLICATE_WORD', `이미 단어장에 있는 단어입니다: ${entry.word}`)
    }

    this.statements.updateWord.run(
      entry.word,
      entry.normalizedWord,
      entry.meaning,
      entry.partOfSpeech,
      entry.memo,
      entry.folderId,
      entry.updatedAt,
      entry.quizStats.attempts,
      entry.quizStats.knownCount,
      entry.quizStats.unknownCount,
      entry.quizStats.lastResult,
      entry.quizStats.lastReviewedAt,
      entry.id,
      userId,
    )
    return entry
  }

  moveWords(userId, ids, folderId) {
    const target = typeof folderId === 'string' && folderId.trim() ? folderId.trim() : null
    this.#assertFolder(userId, target)
    const now = new Date().toISOString()
    return this.transaction(() => uniqueIds(ids).reduce((count, id) => {
      const result = this.statements.moveWord.run(target, now, id, userId, target)
      return count + Number(result.changes)
    }, 0))
  }

  deleteWords(userId, ids) {
    return this.transaction(() => uniqueIds(ids).reduce((count, id) => {
      const result = this.statements.deleteWord.run(id, userId)
      return count + Number(result.changes)
    }, 0))
  }

  recordQuizResult(userId, id, result) {
    const row = this.statements.getWord.get(id, userId)
    if (!row) throw notFound('WORD_NOT_FOUND', '단어를 찾을 수 없습니다.')
    const entry = mapWord(row)
    const now = new Date().toISOString()
    entry.quizStats.attempts += 1
    if (result === 'known') entry.quizStats.knownCount += 1
    else entry.quizStats.unknownCount += 1
    entry.quizStats.lastResult = result
    entry.quizStats.lastReviewedAt = now
    entry.updatedAt = now
    this.statements.updateQuiz.run(
      entry.quizStats.attempts,
      entry.quizStats.knownCount,
      entry.quizStats.unknownCount,
      result,
      now,
      now,
      id,
      userId,
    )
    return entry
  }

  importVocabulary(
    userId,
    entries,
    mode,
    folderInputs,
    limits = {},
  ) {
    const importMode = mode === 'replace' ? 'replace' : 'merge'
    const wordInputs = Array.isArray(entries) ? entries : []
    const folders = Array.isArray(folderInputs) ? folderInputs : []

    return this.transaction(() => {
      if (importMode === 'replace') {
        this.statements.deleteUserWords.run(userId)
        this.statements.deleteUserFolders.run(userId)
      }

      const foldersAdded = []
      const foldersReused = []
      const reusedIds = new Set()
      const idMap = new Map()

      for (const input of folders) {
        const sourceId = typeof input?.id === 'string' ? input.id.trim() : ''
        const normalizedName = normalizeFolderName(input?.name)
        const matching = this.statements.getFolderByName.get(userId, normalizedName)
        if (matching) {
          const mapped = mapFolder(matching)
          if (sourceId) idMap.set(sourceId, mapped.id)
          if (!reusedIds.has(mapped.id)) {
            reusedIds.add(mapped.id)
            foldersReused.push(mapped)
          }
          continue
        }

        const folderCount = Number(this.statements.countFolders.get(userId).count)
        if (folderCount >= (limits.maxFolders ?? Number.POSITIVE_INFINITY)) {
          throw limitExceeded(
            `폴더는 계정당 최대 ${limits.maxFolders}개까지 만들 수 있습니다.`,
          )
        }

        const folder = this.#insertFolder(userId, input)
        if (sourceId) idMap.set(sourceId, folder.id)
        foldersAdded.push(folder)
      }

      const existingWords = new Set(
        this.statements.getWords.all(userId).map((row) => row.normalized_word),
      )
      const added = []
      const duplicates = []
      for (const input of wordInputs) {
        const normalized = normalizeWord(input?.word)
        if (existingWords.has(normalized)) {
          duplicates.push(input)
          continue
        }
        if (existingWords.size >= (limits.maxWords ?? Number.POSITIVE_INFINITY)) {
          throw limitExceeded(
            `단어는 계정당 최대 ${limits.maxWords}개까지 저장할 수 있습니다.`,
          )
        }
        const sourceFolderId = typeof input?.folderId === 'string' && input.folderId.trim()
          ? input.folderId.trim()
          : null
        const folderId = sourceFolderId === null
          ? null
          : idMap.get(sourceFolderId) ?? sourceFolderId
        const entry = this.#insertWord(userId, { ...input, folderId })
        existingWords.add(entry.normalizedWord)
        added.push(entry)
      }

      return { mode: importMode, added, duplicates, foldersAdded, foldersReused }
    })
  }

  close() {
    this.sqlite.close()
  }
}
