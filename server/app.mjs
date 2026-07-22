import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import {
  ApiError,
  badRequest,
  forbidden,
  limitExceeded,
  notFound,
  unauthorized,
} from './errors.mjs'
import { loadConfig } from './config.mjs'
import { WordLensDatabase } from './database.mjs'
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from './security.mjs'
import { normalizeUsername, uniqueIds, validateCredentials } from './validation.mjs'

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, { ...JSON_HEADERS, ...extraHeaders })
  response.end(JSON.stringify(payload))
}

function readJson(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let finished = false

    request.on('data', (chunk) => {
      if (finished) return
      size += chunk.length
      if (size > maxBytes) {
        finished = true
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', '요청 데이터가 너무 큽니다.'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (finished) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new TypeError('object expected')
        }
        resolve(parsed)
      } catch {
        reject(badRequest('INVALID_JSON', '올바른 JSON 요청이 아닙니다.'))
      }
    })
    request.on('error', (error) => {
      if (!finished) reject(error)
    })
  })
}

function bearerToken(request) {
  const authorization = request.headers.authorization ?? ''
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  return match?.[1] ?? ''
}

function clientAddress(request) {
  const directAddress = request.socket.remoteAddress ?? 'unknown'
  const fromLoopback = directAddress === '127.0.0.1'
    || directAddress === '::1'
    || directAddress === '::ffff:127.0.0.1'
  if (!fromLoopback) return directAddress

  const forwardedHeader = request.headers['x-forwarded-for']
  const forwarded = Array.isArray(forwardedHeader)
    ? forwardedHeader[0]
    : forwardedHeader
  const candidate = forwarded?.split(',')[0].trim() ?? ''
  return isIP(candidate) ? candidate : directAddress
}

function createRateLimiter() {
  const buckets = new Map()
  return (request, category, limit, windowMs, identity = clientAddress(request)) => {
    const now = Date.now()
    if (buckets.size >= 10_000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey)
      }
      if (buckets.size >= 20_000) {
        throw new ApiError(
          429,
          'RATE_LIMITED',
          '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
        )
      }
    }
    const key = `${category}:${identity}`
    const current = buckets.get(key)
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return
    }
    current.count += 1
    if (current.count > limit) {
      throw new ApiError(429, 'RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.')
    }
  }
}

function createCorsHeaders(origin, allowedOrigins) {
  if (!origin) return {}
  const normalized = origin.replace(/\/$/, '')
  if (!allowedOrigins.includes(normalized)) {
    throw forbidden('허용되지 않은 웹사이트에서 보낸 요청입니다.')
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt }
}

export function createWordLensServer(overrides = {}) {
  const config = loadConfig(overrides)
  const database = overrides.database ?? new WordLensDatabase(config.databasePath, {
    maxDatabaseBytes: config.maxDatabaseBytes,
  })
  const rateLimit = createRateLimiter()
  const dummyPasswordHash = hashPassword('invalid-password-placeholder')

  const issueSession = (user) => {
    const token = createSessionToken()
    const now = new Date()
    const expiresAt = new Date(
      now.getTime() + config.sessionDays * 24 * 60 * 60 * 1000,
    )
    database.deleteExpiredSessions(now.toISOString())
    database.createSession({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })
    return { token, expiresAt: expiresAt.toISOString(), user: publicUser(user) }
  }

  const authenticate = (request) => {
    const token = bearerToken(request)
    if (!token) throw unauthorized()
    const now = new Date().toISOString()
    const user = database.findUserBySession(hashSessionToken(token), now)
    if (!user) throw unauthorized('로그인이 만료되었습니다. 다시 로그인해 주세요.')
    return { token, user }
  }

  const handler = async (request, response) => {
    let corsHeaders = {}
    try {
      corsHeaders = createCorsHeaders(request.headers.origin, config.allowedOrigins)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders)
        response.end()
        return
      }

      const requestUrl = new URL(request.url ?? '/', 'http://localhost')
      const path = requestUrl.pathname.replace(/\/$/, '') || '/'

      if (request.method === 'GET' && path === '/api/health') {
        sendJson(response, 200, { ok: true, service: 'wordlens-api' }, corsHeaders)
        return
      }

      if (request.method === 'POST' && path === '/api/auth/register') {
        rateLimit(request, 'register', 20, 15 * 60 * 1000)
        const body = await readJson(request, config.maxBodyBytes)
        const credentials = validateCredentials(body)
        if (config.registrationMode === 'closed') {
          throw forbidden('현재 새 회원가입을 받지 않습니다.')
        }
        if (
          config.registrationMode === 'invite'
          && body.inviteCode !== config.inviteCode
        ) {
          throw forbidden('초대 코드가 올바르지 않습니다.')
        }
        const now = new Date().toISOString()
        const passwordHash = await hashPassword(credentials.password)
        if (database.countUsers() >= config.maxUsers) {
          throw limitExceeded(`이 서버는 최대 ${config.maxUsers}개 계정까지 가입할 수 있습니다.`)
        }
        const user = database.createUser({
          id: randomUUID(),
          username: credentials.username,
          usernameKey: credentials.usernameKey,
          passwordHash,
          createdAt: now,
        })
        sendJson(response, 201, issueSession(user), corsHeaders)
        return
      }

      if (request.method === 'POST' && path === '/api/auth/login') {
        rateLimit(request, 'login-client', 60, 15 * 60 * 1000)
        const body = await readJson(request, config.maxBodyBytes)
        const username = typeof body.username === 'string' ? body.username : ''
        const password = typeof body.password === 'string' ? body.password : ''
        const credentialsHaveValidSize = username.length <= 128 && password.length <= 128
        const usernameKey = credentialsHaveValidSize
          ? normalizeUsername(username)
          : '<invalid>'
        rateLimit(
          request,
          'login-account',
          20,
          15 * 60 * 1000,
          usernameKey || '<invalid>',
        )
        const row = credentialsHaveValidSize
          ? database.findUserForLogin(usernameKey)
          : null
        const passwordMatches = row
          ? await verifyPassword(password, row.password_hash)
          : await verifyPassword(
              credentialsHaveValidSize ? password : '',
              await dummyPasswordHash,
            )
        if (!row || !passwordMatches) {
          throw unauthorized('아이디 또는 비밀번호가 올바르지 않습니다.')
        }
        const user = {
          id: row.id,
          username: row.username,
          createdAt: row.created_at,
        }
        sendJson(response, 200, issueSession(user), corsHeaders)
        return
      }

      const { token, user } = authenticate(request)

      if (request.method === 'GET' && path === '/api/auth/me') {
        sendJson(response, 200, { user: publicUser(user) }, corsHeaders)
        return
      }

      if (request.method === 'POST' && path === '/api/auth/logout') {
        database.deleteSession(hashSessionToken(token))
        sendJson(response, 200, { ok: true }, corsHeaders)
        return
      }

      if (request.method === 'GET' && path === '/api/vocabulary') {
        sendJson(response, 200, database.getVocabulary(user.id), corsHeaders)
        return
      }

      if (request.method === 'POST' && path === '/api/folders') {
        const body = await readJson(request, config.maxBodyBytes)
        sendJson(
          response,
          201,
          { folder: database.createFolder(user.id, body.name, config.maxFoldersPerUser) },
          corsHeaders,
        )
        return
      }

      const folderMatch = /^\/api\/folders\/([^/]+)$/.exec(path)
      if (folderMatch && request.method === 'PATCH') {
        const body = await readJson(request, config.maxBodyBytes)
        const id = decodeURIComponent(folderMatch[1])
        sendJson(response, 200, { folder: database.renameFolder(user.id, id, body.name) }, corsHeaders)
        return
      }
      if (folderMatch && request.method === 'DELETE') {
        const id = decodeURIComponent(folderMatch[1])
        sendJson(response, 200, database.removeFolder(user.id, id), corsHeaders)
        return
      }

      if (request.method === 'POST' && path === '/api/words/batch') {
        const body = await readJson(request, config.maxBodyBytes)
        sendJson(
          response,
          201,
          database.addWords(user.id, body.entries, config.maxWordsPerUser),
          corsHeaders,
        )
        return
      }

      if (request.method === 'PUT' && path === '/api/words') {
        const body = await readJson(request, config.maxBodyBytes)
        sendJson(
          response,
          200,
          { entry: database.putWord(user.id, body.entry, config.maxWordsPerUser) },
          corsHeaders,
        )
        return
      }

      if (request.method === 'POST' && path === '/api/words/move') {
        const body = await readJson(request, config.maxBodyBytes)
        const moved = database.moveWords(user.id, body.ids, body.folderId)
        sendJson(response, 200, { moved }, corsHeaders)
        return
      }

      if (request.method === 'DELETE' && path === '/api/words') {
        const body = await readJson(request, config.maxBodyBytes)
        const deleted = database.deleteWords(user.id, body.ids)
        sendJson(response, 200, { deleted }, corsHeaders)
        return
      }

      const quizMatch = /^\/api\/words\/([^/]+)\/quiz$/.exec(path)
      if (quizMatch && request.method === 'POST') {
        const body = await readJson(request, config.maxBodyBytes)
        if (body.result !== 'known' && body.result !== 'unknown') {
          throw badRequest('INVALID_QUIZ_RESULT', '올바른 퀴즈 결과가 아닙니다.')
        }
        const id = decodeURIComponent(quizMatch[1])
        sendJson(
          response,
          200,
          { entry: database.recordQuizResult(user.id, id, body.result) },
          corsHeaders,
        )
        return
      }

      if (request.method === 'POST' && path === '/api/vocabulary/import') {
        const body = await readJson(request, config.maxBodyBytes)
        sendJson(
          response,
          200,
          database.importVocabulary(
            user.id,
            body.entries,
            body.mode,
            body.folders,
            {
              maxWords: config.maxWordsPerUser,
              maxFolders: config.maxFoldersPerUser,
            },
          ),
          corsHeaders,
        )
        return
      }

      throw notFound('ROUTE_NOT_FOUND', '요청한 API를 찾을 수 없습니다.')
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(
          response,
          error.status,
          { error: { code: error.code, message: error.message } },
          corsHeaders,
        )
        return
      }
      if (
        String(error?.code ?? '') === 'ERR_SQLITE_FULL'
        || /database or disk is full/i.test(String(error?.message ?? ''))
      ) {
        sendJson(
          response,
          507,
          {
            error: {
              code: 'SERVER_STORAGE_FULL',
              message: '서버 저장 공간 상한에 도달했습니다. 관리자에게 알려 주세요.',
            },
          },
          corsHeaders,
        )
        return
      }
      console.error('[WordLens API]', error)
      sendJson(
        response,
        500,
        { error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' } },
        corsHeaders,
      )
    }
  }

  const server = createServer(handler)
  let closed = false

  return {
    config,
    database,
    server,
    async start() {
      await dummyPasswordHash
      database.deleteExpiredSessions(new Date().toISOString())
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : config.port
      return `http://${config.host}:${port}`
    },
    async close() {
      if (closed) return
      closed = true
      await new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => (error ? reject(error) : resolve()))
      })
      database.close()
    },
  }
}
