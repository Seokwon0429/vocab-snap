import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enrichWithKoreanDefinitions,
  lookupKoreanDefinitions,
  resetKoreanDictionaryCache,
} from './koreanDictionary'

afterEach(() => {
  resetKoreanDictionaryCache()
  vi.unstubAllGlobals()
})

describe('오프라인 한글 뜻 사전', () => {
  it('첫 글자 청크를 한 번만 읽고 뜻과 품사를 찾는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ apple: { m: '사과', p: '명사' }, able: { m: '할 수 있는', p: '형용사' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await lookupKoreanDefinitions(['Apple', 'able'])

    expect(result.unavailable).toBe(false)
    expect(result.definitions.get('apple')).toEqual({ meaning: '사과', partOfSpeech: '명사' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/dictionary/ko-en/a.json')
  })

  it('빈 필드만 자동으로 채우고 사용자가 쓴 뜻은 보존한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ run: { m: '달리다', p: '동사' } }), { status: 200 }),
      ),
    )

    const result = await enrichWithKoreanDefinitions([
      { word: 'run' },
      { word: 'run', meaning: '직접 입력한 뜻', partOfSpeech: '내 품사' },
    ])

    expect(result.entries[0]).toMatchObject({ meaning: '달리다', partOfSpeech: '동사' })
    expect(result.entries[1]).toMatchObject({ meaning: '직접 입력한 뜻', partOfSpeech: '내 품사' })
  })

  it('사전 파일을 읽지 못해도 빈 값으로 저장할 수 있게 한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const result = await enrichWithKoreanDefinitions([{ word: 'missing' }])

    expect(result.unavailable).toBe(true)
    expect(result.entries).toEqual([{ word: 'missing' }])
  })
})
