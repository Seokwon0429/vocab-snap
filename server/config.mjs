import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const serverDirectory = dirname(fileURLToPath(import.meta.url))

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseOrigins(value) {
  return String(value)
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

function parseRegistrationMode(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  return mode === 'open' || mode === 'closed' ? mode : 'invite'
}

export function loadConfig(overrides = {}) {
  const env = process.env
  const registrationMode = parseRegistrationMode(
    overrides.registrationMode ?? env.WORDLENS_REGISTRATION_MODE,
  )
  const configuredInviteCode = overrides.inviteCode
    ?? env.WORDLENS_INVITE_CODE
    ?? ''
  const generatedInviteCode = registrationMode === 'invite' && !configuredInviteCode
  const databasePath = overrides.databasePath
    ?? env.WORDLENS_DB_PATH
    ?? resolve(serverDirectory, 'data', 'wordlens.sqlite')

  return {
    host: overrides.host ?? env.WORDLENS_HOST ?? '127.0.0.1',
    port: overrides.port ?? parsePositiveInteger(env.WORDLENS_PORT, 8787),
    databasePath,
    allowedOrigins: overrides.allowedOrigins ?? parseOrigins(
      env.WORDLENS_ALLOWED_ORIGINS
        ?? 'http://localhost:5173,http://127.0.0.1:5173,https://seokwon0429.github.io',
    ),
    registrationMode,
    inviteCode: generatedInviteCode
      ? randomBytes(18).toString('base64url')
      : configuredInviteCode,
    generatedInviteCode,
    sessionDays: overrides.sessionDays
      ?? parsePositiveInteger(env.WORDLENS_SESSION_DAYS, 30),
    maxBodyBytes: overrides.maxBodyBytes
      ?? parsePositiveInteger(env.WORDLENS_MAX_BODY_BYTES, 5 * 1024 * 1024),
    maxUsers: overrides.maxUsers
      ?? parsePositiveInteger(env.WORDLENS_MAX_USERS, 50),
    maxWordsPerUser: overrides.maxWordsPerUser
      ?? parsePositiveInteger(env.WORDLENS_MAX_WORDS_PER_USER, 20_000),
    maxFoldersPerUser: overrides.maxFoldersPerUser
      ?? parsePositiveInteger(env.WORDLENS_MAX_FOLDERS_PER_USER, 500),
    maxDatabaseBytes: overrides.maxDatabaseBytes
      ?? parsePositiveInteger(env.WORDLENS_MAX_DATABASE_BYTES, 1024 * 1024 * 1024),
  }
}
