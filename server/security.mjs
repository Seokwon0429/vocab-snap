import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const KEY_LENGTH = 32
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  })

  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString('base64url'),
    Buffer.from(derivedKey).toString('base64url'),
  ].join('$')
}

export async function verifyPassword(password, encodedHash) {
  const [algorithm, cost, blockSize, parallelization, saltText, hashText] =
    String(encodedHash).split('$')
  if (
    algorithm !== 'scrypt'
    || !cost
    || !blockSize
    || !parallelization
    || !saltText
    || !hashText
  ) {
    return false
  }

  try {
    const expected = Buffer.from(hashText, 'base64url')
    const actual = await scrypt(
      password,
      Buffer.from(saltText, 'base64url'),
      expected.length,
      {
        N: Number(cost),
        r: Number(blockSize),
        p: Number(parallelization),
        maxmem: 64 * 1024 * 1024,
      },
    )
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex')
}
