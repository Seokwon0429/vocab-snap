import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const databasePath = resolve(
  process.env.WORDLENS_DB_PATH
    ?? resolve(repositoryRoot, 'server', 'data', 'wordlens.sqlite'),
)
const outputPath = resolve(
  process.env.WORDLENS_DATA_VIEW_PATH
    ?? resolve(repositoryRoot, 'server', 'data', 'wordlens-data-view.json'),
)

if (!existsSync(databasePath)) {
  throw new Error(`WordLens 데이터베이스를 찾을 수 없습니다: ${databasePath}`)
}

const database = new DatabaseSync(databasePath, { readOnly: true })
database.exec('PRAGMA busy_timeout = 5000')

try {
  database.exec('BEGIN')

  const hasRoleColumn = database.prepare('PRAGMA table_info(users)').all()
    .some((column) => column.name === 'role')
  const roleSelection = hasRoleColumn ? 'users.role' : "'user' AS role"

  const summary = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS total_user_count,
      (SELECT COUNT(*) FROM folders) AS total_folder_count,
      (SELECT COUNT(*) FROM words) AS total_word_count
  `).get()

  const users = database.prepare(`
    SELECT
      users.id AS user_id,
      users.username,
      ${roleSelection},
      users.created_at,
      (SELECT COUNT(*) FROM folders WHERE folders.user_id = users.id) AS folder_count,
      (SELECT COUNT(*) FROM words WHERE words.user_id = users.id) AS word_count
    FROM users
    ORDER BY users.created_at ASC, users.username_key ASC
  `).all()

  database.exec('COMMIT')

  const view = {
    generatedAt: new Date().toISOString(),
    notice: '읽기 전용 통계입니다. 비밀번호 해시와 로그인 세션은 포함하지 않습니다.',
    summary: {
      totalUserCount: summary.total_user_count,
      totalFolderCount: summary.total_folder_count,
      totalWordCount: summary.total_word_count,
    },
    users: users.map((user) => ({
      userId: user.user_id,
      username: user.username,
      role: user.role === 'admin' ? 'admin' : 'user',
      createdAt: user.created_at,
      folderCount: user.folder_count,
      wordCount: user.word_count,
    })),
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(view, null, 2)}\n`, 'utf8')
  console.log(`WordLens DB 조회 파일을 만들었습니다: ${outputPath}`)
} catch (error) {
  try {
    database.exec('ROLLBACK')
  } catch {
    // 읽기 트랜잭션이 이미 끝났다면 되돌릴 작업이 없습니다.
  }
  throw error
} finally {
  database.close()
}
