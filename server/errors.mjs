export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function badRequest(code, message) {
  return new ApiError(400, code, message)
}

export function unauthorized(message = '로그인이 필요합니다.') {
  return new ApiError(401, 'UNAUTHORIZED', message)
}

export function forbidden(message = '요청할 권한이 없습니다.') {
  return new ApiError(403, 'FORBIDDEN', message)
}

export function notFound(code, message) {
  return new ApiError(404, code, message)
}

export function conflict(code, message) {
  return new ApiError(409, code, message)
}

export function limitExceeded(message) {
  return new ApiError(409, 'STORAGE_LIMIT_REACHED', message)
}
