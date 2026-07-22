import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createWordLensServer } from './app.mjs'
import { WordLensDatabase } from './database.mjs'
import { runSetUserRoleCli } from './set-user-role.mjs'

let application
let apiBase

before(async () => {
  application = createWordLensServer({
    host: '127.0.0.1',
    port: 0,
    databasePath: ':memory:',
    allowedOrigins: ['http://localhost:5173'],
    registrationMode: 'open',
    sessionDays: 1,
  })
  apiBase = `${await application.start()}/api`
})

after(async () => {
  await application.close()
})

async function requestAt(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:5173',
      ...(options.headers ?? {}),
    },
  })
  const payload = await response.json()
  return { response, payload }
}

function request(path, options = {}) {
  return requestAt(apiBase, path, options)
}

async function register(username) {
  const { response, payload } = await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'correct-horse-123' }),
  })
  assert.equal(response.status, 201)
  return payload.token
}

test('회원가입, 로그인 복구, 로그아웃을 처리한다', async () => {
  const token = await register('tester_one')
  const me = await request('/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(me.response.status, 200)
  assert.equal(me.payload.user.username, 'tester_one')
  assert.equal(me.payload.user.role, 'user')

  const login = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'TESTER_ONE', password: 'correct-horse-123' }),
  })
  assert.equal(login.response.status, 200)
  assert.ok(login.payload.token)
  assert.equal(login.payload.user.role, 'user')

  const logout = await request('/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.payload.token}` },
  })
  assert.equal(logout.response.status, 200)
  const expired = await request('/auth/me', {
    headers: { Authorization: `Bearer ${login.payload.token}` },
  })
  assert.equal(expired.response.status, 401)
})

test('사용자별로 단어와 폴더를 분리하고 퀴즈 기록을 저장한다', async () => {
  const firstToken = await register('first_user')
  const secondToken = await register('second_user')
  const firstAuth = { Authorization: `Bearer ${firstToken}` }
  const secondAuth = { Authorization: `Bearer ${secondToken}` }

  const folder = await request('/folders', {
    method: 'POST',
    headers: firstAuth,
    body: JSON.stringify({ name: '복습' }),
  })
  assert.equal(folder.response.status, 201)

  const words = await request('/words/batch', {
    method: 'POST',
    headers: firstAuth,
    body: JSON.stringify({
      entries: [
        { word: 'Apple', meaning: '사과', folderId: folder.payload.folder.id },
        { word: 'apple', meaning: '중복' },
      ],
    }),
  })
  assert.equal(words.payload.added.length, 1)
  assert.equal(words.payload.duplicates.length, 1)

  const firstVocabulary = await request('/vocabulary', { headers: firstAuth })
  const secondVocabulary = await request('/vocabulary', { headers: secondAuth })
  assert.equal(firstVocabulary.payload.entries.length, 1)
  assert.equal(secondVocabulary.payload.entries.length, 0)

  const reviewed = await request(`/words/${words.payload.added[0].id}/quiz`, {
    method: 'POST',
    headers: firstAuth,
    body: JSON.stringify({ result: 'known' }),
  })
  assert.equal(reviewed.payload.entry.quizStats.knownCount, 1)

  const secondWords = await request('/words/batch', {
    method: 'POST',
    headers: secondAuth,
    body: JSON.stringify({ entries: [{ word: 'Apple', meaning: 'second user' }] }),
  })
  assert.equal(secondWords.response.status, 201)
  assert.equal(secondWords.payload.added.length, 1)

  const crossUserFolder = await request('/words/batch', {
    method: 'POST',
    headers: secondAuth,
    body: JSON.stringify({
      entries: [{ word: 'banana', folderId: folder.payload.folder.id }],
    }),
  })
  assert.equal(crossUserFolder.response.status, 404)

  const crossUserQuiz = await request(`/words/${words.payload.added[0].id}/quiz`, {
    method: 'POST',
    headers: secondAuth,
    body: JSON.stringify({ result: 'unknown' }),
  })
  assert.equal(crossUserQuiz.response.status, 404)

  const crossUserMove = await request('/words/move', {
    method: 'POST',
    headers: secondAuth,
    body: JSON.stringify({ ids: [words.payload.added[0].id], folderId: null }),
  })
  assert.equal(crossUserMove.response.status, 200)
  assert.equal(crossUserMove.payload.moved, 0)

  const crossUserDelete = await request('/words', {
    method: 'DELETE',
    headers: secondAuth,
    body: JSON.stringify({ ids: [words.payload.added[0].id] }),
  })
  assert.equal(crossUserDelete.response.status, 200)
  assert.equal(crossUserDelete.payload.deleted, 0)

  const firstAfterCrossUserRequests = await request('/vocabulary', { headers: firstAuth })
  assert.equal(firstAfterCrossUserRequests.payload.entries.length, 1)
  assert.equal(firstAfterCrossUserRequests.payload.entries[0].folderId, folder.payload.folder.id)
  assert.equal(firstAfterCrossUserRequests.payload.entries[0].quizStats.knownCount, 1)
})

test('다른 Origin과 인증 없는 단어 요청을 거부한다', async () => {
  const disallowed = await fetch(`${apiBase}/health`, {
    headers: { Origin: 'https://attacker.example' },
  })
  assert.equal(disallowed.status, 403)

  const unauthenticated = await request('/vocabulary')
  assert.equal(unauthenticated.response.status, 401)
})

test('기본 설정에서는 자동 생성 초대 코드가 있어야 가입할 수 있다', async () => {
  const inviteApplication = createWordLensServer({
    host: '127.0.0.1',
    port: 0,
    databasePath: ':memory:',
    allowedOrigins: ['http://localhost:5173'],
  })
  const inviteApiBase = `${await inviteApplication.start()}/api`
  try {
    const denied = await requestAt(inviteApiBase, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'invite_user', password: 'correct-horse-123' }),
    })
    assert.equal(denied.response.status, 403)

    const accepted = await requestAt(inviteApiBase, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'invite_user',
        password: 'correct-horse-123',
        inviteCode: inviteApplication.config.inviteCode,
      }),
    })
    assert.equal(accepted.response.status, 201)
  } finally {
    await inviteApplication.close()
  }
})

test('서버를 다시 시작해도 SQLite 단어장과 로그인이 유지된다', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'wordlens-server-test-'))
  const databasePath = join(temporaryDirectory, 'wordlens.sqlite')
  let persistentApplication
  try {
    persistentApplication = createWordLensServer({
      host: '127.0.0.1',
      port: 0,
      databasePath,
      allowedOrigins: ['http://localhost:5173'],
      registrationMode: 'open',
    })
    let persistentApiBase = `${await persistentApplication.start()}/api`
    const registered = await requestAt(persistentApiBase, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'saved_user', password: 'correct-horse-123' }),
    })
    assert.equal(registered.response.status, 201)
    const added = await requestAt(persistentApiBase, '/words/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.payload.token}` },
      body: JSON.stringify({ entries: [{ word: 'persistent', meaning: '지속되는' }] }),
    })
    assert.equal(added.response.status, 201)
    await persistentApplication.close()

    persistentApplication = createWordLensServer({
      host: '127.0.0.1',
      port: 0,
      databasePath,
      allowedOrigins: ['http://localhost:5173'],
      registrationMode: 'open',
    })
    persistentApiBase = `${await persistentApplication.start()}/api`
    const login = await requestAt(persistentApiBase, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'saved_user', password: 'correct-horse-123' }),
    })
    assert.equal(login.response.status, 200)

    const vocabulary = await requestAt(persistentApiBase, '/vocabulary', {
      headers: { Authorization: `Bearer ${login.payload.token}` },
    })
    assert.equal(vocabulary.payload.entries[0].word, 'persistent')
  } finally {
    await persistentApplication?.close()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

test('admin stats require an admin and expose only aggregate account data', async () => {
  const adminApplication = createWordLensServer({
    host: '127.0.0.1',
    port: 0,
    databasePath: ':memory:',
    allowedOrigins: ['http://localhost:5173'],
    registrationMode: 'open',
  })
  const adminApiBase = `${await adminApplication.start()}/api`

  try {
    const registeredAdmin = await requestAt(adminApiBase, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'stats_admin',
        password: 'correct-horse-123',
        role: 'admin',
      }),
    })
    assert.equal(registeredAdmin.response.status, 201)
    assert.equal(registeredAdmin.payload.user.role, 'user')

    const registeredFirstUser = await requestAt(adminApiBase, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'stats_user_one', password: 'correct-horse-123' }),
    })
    const registeredSecondUser = await requestAt(adminApiBase, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'stats_user_two', password: 'correct-horse-123' }),
    })
    assert.equal(registeredFirstUser.response.status, 201)
    assert.equal(registeredSecondUser.response.status, 201)

    const promoted = adminApplication.database.setUserRoleById(
      registeredAdmin.payload.user.id,
      'admin',
    )
    assert.equal(promoted.role, 'admin')

    const adminAuth = { Authorization: `Bearer ${registeredAdmin.payload.token}` }
    const firstAuth = { Authorization: `Bearer ${registeredFirstUser.payload.token}` }
    const secondAuth = { Authorization: `Bearer ${registeredSecondUser.payload.token}` }

    const adminMe = await requestAt(adminApiBase, '/auth/me', { headers: adminAuth })
    assert.equal(adminMe.response.status, 200)
    assert.equal(adminMe.payload.user.role, 'admin')

    const unauthenticated = await requestAt(adminApiBase, '/admin/stats')
    assert.equal(unauthenticated.response.status, 401)
    assert.equal(unauthenticated.response.headers.get('cache-control'), 'no-store')

    const regularUser = await requestAt(adminApiBase, '/admin/stats', { headers: firstAuth })
    assert.equal(regularUser.response.status, 403)
    assert.equal(regularUser.response.headers.get('cache-control'), 'no-store')

    const firstFolder = await requestAt(adminApiBase, '/folders', {
      method: 'POST',
      headers: firstAuth,
      body: JSON.stringify({ name: 'First deck' }),
    })
    assert.equal(firstFolder.response.status, 201)
    const firstWords = await requestAt(adminApiBase, '/words/batch', {
      method: 'POST',
      headers: firstAuth,
      body: JSON.stringify({
        entries: [
          { word: 'alpha', folderId: firstFolder.payload.folder.id },
          { word: 'beta' },
        ],
      }),
    })
    assert.equal(firstWords.response.status, 201)

    for (const name of ['Second deck A', 'Second deck B']) {
      const folder = await requestAt(adminApiBase, '/folders', {
        method: 'POST',
        headers: secondAuth,
        body: JSON.stringify({ name }),
      })
      assert.equal(folder.response.status, 201)
    }
    const secondWords = await requestAt(adminApiBase, '/words/batch', {
      method: 'POST',
      headers: secondAuth,
      body: JSON.stringify({ entries: [{ word: 'gamma' }] }),
    })
    assert.equal(secondWords.response.status, 201)

    const stats = await requestAt(adminApiBase, '/admin/stats', { headers: adminAuth })
    assert.equal(stats.response.status, 200)
    assert.equal(stats.response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(stats.payload.summary, {
      totalUserCount: 3,
      totalFolderCount: 3,
      totalWordCount: 3,
    })
    assert.equal(stats.payload.users.length, 3)

    const firstUserStats = stats.payload.users.find(
      (user) => user.userId === registeredFirstUser.payload.user.id,
    )
    const secondUserStats = stats.payload.users.find(
      (user) => user.userId === registeredSecondUser.payload.user.id,
    )
    assert.deepEqual(
      Object.keys(firstUserStats).sort(),
      ['createdAt', 'folderCount', 'userId', 'username', 'wordCount'].sort(),
    )
    assert.equal(firstUserStats.folderCount, 1)
    assert.equal(firstUserStats.wordCount, 2)
    assert.equal(secondUserStats.folderCount, 2)
    assert.equal(secondUserStats.wordCount, 1)

    const serializedStats = JSON.stringify(stats.payload)
    assert.doesNotMatch(serializedStats, /password_hash|passwordHash|token_hash|tokenHash/i)
    assert.doesNotMatch(serializedStats, /alpha|beta|gamma/)

    const adminVocabulary = await requestAt(adminApiBase, '/vocabulary', {
      headers: adminAuth,
    })
    assert.equal(adminVocabulary.response.status, 200)
    assert.deepEqual(adminVocabulary.payload, { folders: [], entries: [] })

    const adminCrossUserQuiz = await requestAt(
      adminApiBase,
      `/words/${firstWords.payload.added[0].id}/quiz`,
      {
        method: 'POST',
        headers: adminAuth,
        body: JSON.stringify({ result: 'known' }),
      },
    )
    assert.equal(adminCrossUserQuiz.response.status, 404)

    const adminCrossUserDelete = await requestAt(adminApiBase, '/words', {
      method: 'DELETE',
      headers: adminAuth,
      body: JSON.stringify({ ids: [firstWords.payload.added[0].id] }),
    })
    assert.equal(adminCrossUserDelete.response.status, 200)
    assert.equal(adminCrossUserDelete.payload.deleted, 0)

    const firstVocabularyAfterAdminRequests = await requestAt(adminApiBase, '/vocabulary', {
      headers: firstAuth,
    })
    assert.equal(firstVocabularyAfterAdminRequests.payload.entries.length, 2)

    adminApplication.database.setUserRoleById(registeredAdmin.payload.user.id, 'user')
    const demoted = await requestAt(adminApiBase, '/admin/stats', { headers: adminAuth })
    assert.equal(demoted.response.status, 403)
    adminApplication.database.setUserRoleById(registeredAdmin.payload.user.id, 'admin')
    const rePromoted = await requestAt(adminApiBase, '/admin/stats', { headers: adminAuth })
    assert.equal(rePromoted.response.status, 200)

    const noPromotionRoute = await requestAt(
      adminApiBase,
      `/admin/users/${registeredFirstUser.payload.user.id}/role`,
      {
        method: 'PATCH',
        headers: adminAuth,
        body: JSON.stringify({ role: 'admin' }),
      },
    )
    assert.equal(noPromotionRoute.response.status, 404)
  } finally {
    await adminApplication.close()
  }
})

test('legacy users gain a constrained user role through an idempotent migration', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'wordlens-role-migration-'))
  const databasePath = join(temporaryDirectory, 'legacy.sqlite')

  try {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    legacy.prepare(`
      INSERT INTO users (id, username, username_key, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      '4ab1407c-af6f-4e5a-b956-bf537fe21234',
      'legacy_user',
      'legacy_user',
      'legacy-password-hash',
      '2026-01-01T00:00:00.000Z',
    )
    legacy.close()

    const migrated = new WordLensDatabase(databasePath)
    assert.equal(migrated.findUserForLogin('legacy_user').role, 'user')
    assert.equal(
      migrated.sqlite.prepare('PRAGMA table_info(users)').all()
        .filter((column) => column.name === 'role').length,
      1,
    )
    assert.throws(
      () => migrated.sqlite.prepare('UPDATE users SET role = ? WHERE id = ?').run(
        'owner',
        '4ab1407c-af6f-4e5a-b956-bf537fe21234',
      ),
      /constraint/i,
    )
    migrated.setUserRoleById('4ab1407c-af6f-4e5a-b956-bf537fe21234', 'admin')
    migrated.close()

    const reopened = new WordLensDatabase(databasePath)
    assert.equal(reopened.findUserForLogin('legacy_user').role, 'admin')
    assert.equal(
      reopened.sqlite.prepare('PRAGMA table_info(users)').all()
        .filter((column) => column.name === 'role').length,
      1,
    )
    reopened.close()
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

test('the local role CLI selects accounts by immutable user ID only', () => {
  const database = new WordLensDatabase(':memory:')
  try {
    const user = database.createUser({
      id: 'f123cfd0-dde1-4e13-b357-d603cc674abc',
      username: 'cli_user',
      usernameKey: 'cli_user',
      passwordHash: 'not-used-in-this-test',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const output = []

    assert.throws(
      () => runSetUserRoleCli([user.username, 'admin'], { database, output: () => {} }),
      (error) => error?.code === 'USER_NOT_FOUND',
    )
    assert.throws(
      () => runSetUserRoleCli([user.id, 'owner'], { database, output: () => {} }),
      /admin.*user|user.*admin/i,
    )

    const promoted = runSetUserRoleCli([user.id, 'admin'], {
      database,
      output: (message) => output.push(message),
    })
    assert.equal(promoted.role, 'admin')
    assert.match(output[0], new RegExp(user.id))
    assert.match(output[0], /cli_user/)

    const demoted = runSetUserRoleCli([user.id, 'user'], {
      database,
      output: () => {},
    })
    assert.equal(demoted.role, 'user')
  } finally {
    database.close()
  }
})
