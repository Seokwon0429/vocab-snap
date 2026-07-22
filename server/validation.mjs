import { randomUUID } from 'node:crypto'
import { badRequest } from './errors.mjs'

const USERNAME_PATTERN = /^[\p{L}\p{N}._-]+$/u

export function normalizeUsername(username) {
  return String(username).trim().normalize('NFKC').toLocaleLowerCase('en-US')
}

export function validateCredentials(input) {
  const username = typeof input?.username === 'string'
    ? input.username.trim().normalize('NFKC')
    : ''
  const password = typeof input?.password === 'string' ? input.password : ''

  if (username.length < 3 || username.length > 32 || !USERNAME_PATTERN.test(username)) {
    throw badRequest(
      'INVALID_USERNAME',
      '아이디는 3~32자의 한글, 영문, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.',
    )
  }
  if (password.length < 8 || password.length > 128) {
    throw badRequest('INVALID_PASSWORD', '비밀번호는 8~128자로 입력해 주세요.')
  }

  return { username, password, usernameKey: normalizeUsername(username) }
}

export function normalizeWord(word) {
  return String(word)
    .trim()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLocaleLowerCase('en-US')
}

export function normalizeFolderName(name) {
  return String(name)
    .trim()
    .replace(/\s+/gu, ' ')
    .normalize('NFC')
    .toLocaleLowerCase('ko-KR')
}

export function cleanText(value, maxLength, fieldName) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length > maxLength) {
    throw badRequest('INVALID_INPUT', `${fieldName}은(는) ${maxLength}자 이하여야 합니다.`)
  }
  return text
}

export function cleanId(value) {
  const id = cleanText(value, 128, 'ID')
  return id || randomUUID()
}

export function cleanIsoDate(value, fallback) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return fallback
  return new Date(value).toISOString()
}

function cleanCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0
}

export function prepareFolderInput(input, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const name = cleanText(input?.name, 80, '폴더 이름')
    .replace(/\s+/gu, ' ')
    .normalize('NFC')
  if (!name) throw badRequest('INVALID_FOLDER', '폴더 이름을 입력해 주세요.')

  return {
    id: cleanId(options.id ?? input?.id),
    name,
    normalizedName: normalizeFolderName(name),
    createdAt: cleanIsoDate(options.createdAt ?? input?.createdAt, now),
    updatedAt: cleanIsoDate(input?.updatedAt, now),
  }
}

export function prepareWordInput(input, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const word = cleanText(input?.word, 120, '단어')
  const normalizedWord = normalizeWord(word)
  if (!normalizedWord) throw badRequest('INVALID_WORD', '단어를 입력해 주세요.')

  const stats = input?.quizStats && typeof input.quizStats === 'object'
    ? input.quizStats
    : {}
  const knownCount = cleanCount(stats.knownCount)
  const unknownCount = cleanCount(stats.unknownCount)
  const attempts = Math.max(cleanCount(stats.attempts), knownCount + unknownCount)
  const lastResult = stats.lastResult === 'known' || stats.lastResult === 'unknown'
    ? stats.lastResult
    : null

  return {
    id: cleanId(options.id ?? input?.id),
    word,
    normalizedWord,
    meaning: cleanText(input?.meaning, 2_000, '뜻'),
    partOfSpeech: cleanText(input?.partOfSpeech, 100, '품사'),
    memo: cleanText(input?.memo, 5_000, '메모'),
    folderId: typeof input?.folderId === 'string' && input.folderId.trim()
      ? cleanText(input.folderId, 128, '폴더 ID')
      : null,
    createdAt: cleanIsoDate(options.createdAt ?? input?.createdAt, now),
    updatedAt: cleanIsoDate(input?.updatedAt, now),
    quizStats: {
      attempts,
      knownCount,
      unknownCount,
      lastResult,
      lastReviewedAt: lastResult
        ? cleanIsoDate(stats.lastReviewedAt, now)
        : null,
    },
  }
}

export function uniqueIds(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map((value) => cleanText(value, 128, 'ID')).filter(Boolean))]
}
