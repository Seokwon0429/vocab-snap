import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { loadConfig } from './config.mjs'
import { WordLensDatabase } from './database.mjs'

const USAGE = '사용법: node server/set-user-role.mjs <userId> <admin|user>'

export function runSetUserRoleCli(args, options = {}) {
  if (!Array.isArray(args) || args.length !== 2) throw new Error(USAGE)

  const userId = typeof args[0] === 'string' ? args[0].trim() : ''
  const role = typeof args[1] === 'string' ? args[1].trim().toLowerCase() : ''
  if (!userId || userId.length > 128) throw new Error(`올바른 userId가 필요합니다.\n${USAGE}`)
  if (role !== 'admin' && role !== 'user') throw new Error(`역할은 admin 또는 user여야 합니다.\n${USAGE}`)

  const ownsDatabase = !options.database
  const database = options.database ?? new WordLensDatabase(
    options.databasePath ?? loadConfig().databasePath,
  )
  const output = options.output ?? console.log

  try {
    const user = database.setUserRoleById(userId, role)
    output(`역할 변경 완료: ${user.username} (${user.id}) -> ${user.role}`)
    return user
  } finally {
    if (ownsDatabase) database.close()
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    runSetUserRoleCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
