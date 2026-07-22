import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createWordLensServer } from './app.mjs'

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

  const login = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'TESTER_ONE', password: 'correct-horse-123' }),
  })
  assert.equal(login.response.status, 200)
  assert.ok(login.payload.token)

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
