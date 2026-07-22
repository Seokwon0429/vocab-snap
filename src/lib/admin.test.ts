import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from './auth'
import { getAdminStats } from './admin'

vi.mock('./auth', () => ({
  apiRequest: vi.fn(),
}))

const apiRequestMock = vi.mocked(apiRequest)

describe('관리자 통계 API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('인증된 관리자 통계 엔드포인트만 조회한다', async () => {
    const response = {
      summary: { totalUserCount: 1, totalFolderCount: 2, totalWordCount: 3 },
      users: [],
    }
    apiRequestMock.mockResolvedValue(response)

    await expect(getAdminStats()).resolves.toEqual(response)
    expect(apiRequestMock).toHaveBeenCalledWith('/admin/stats')
  })
})
