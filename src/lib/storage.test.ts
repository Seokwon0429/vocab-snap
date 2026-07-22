import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: null as null | { token: string },
  localGetAll: vi.fn(),
  remoteGetAll: vi.fn(),
}))

vi.mock('./auth', () => ({
  getAuthSession: () => mocks.session,
}))

vi.mock('./db', async (importOriginal) => ({
  ...await importOriginal<typeof import('./db')>(),
  getAll: mocks.localGetAll,
}))

vi.mock('./serverStorage', () => ({
  getAll: mocks.remoteGetAll,
  getFolders: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  moveWordsToFolder: vi.fn(),
  addMany: vi.fn(),
  put: vi.fn(),
  deleteMany: vi.fn(),
  importEntries: vi.fn(),
  recordQuizResult: vi.fn(),
}))

import { getAll } from './storage'

describe('로그인별 저장소 선택', () => {
  beforeEach(() => {
    mocks.session = null
    mocks.localGetAll.mockReset()
    mocks.remoteGetAll.mockReset()
  })

  it('로그아웃 상태에서는 기존 IndexedDB를 사용한다', async () => {
    mocks.localGetAll.mockResolvedValue([{ id: 'local-word' }])

    await expect(getAll()).resolves.toEqual([{ id: 'local-word' }])
    expect(mocks.localGetAll).toHaveBeenCalledOnce()
    expect(mocks.remoteGetAll).not.toHaveBeenCalled()
  })

  it('로그인 상태에서는 서버만 사용하고 실패해도 로컬로 대체하지 않는다', async () => {
    mocks.session = { token: 'server-token' }
    mocks.remoteGetAll.mockRejectedValue(new Error('server offline'))

    await expect(getAll()).rejects.toThrow('server offline')
    expect(mocks.remoteGetAll).toHaveBeenCalledOnce()
    expect(mocks.localGetAll).not.toHaveBeenCalled()
  })
})
