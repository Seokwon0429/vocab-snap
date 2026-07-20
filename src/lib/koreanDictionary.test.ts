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

  it('원본 사전에 없는 자주 쓰는 단어는 내장 보완 사전에서 찾는다', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('정적 청크를 읽으면 안 됩니다.'))
    vi.stubGlobal('fetch', fetchMock)
    const missingWords = [
      'exposure',
      'expressed',
      'extrovert',
      'illogical',
      'combination',
      'composition',
      'disability',
      'disarray',
      'disillusioned',
      'dismount',
      'disputable',
      'enable',
      'encouraging',
      'enhance',
    ]

    const result = await lookupKoreanDefinitions(missingWords)

    expect(result.unavailable).toBe(false)
    expect(result.definitions.size).toBe(missingWords.length)
    expect(result.definitions.get('exposure')).toEqual({
      meaning: '노출; 폭로; 사진의 노출',
      partOfSpeech: '명사',
    })
    expect(result.definitions.get('encouraging')).toEqual({
      meaning: '격려하는; 고무적인',
      partOfSpeech: '형용사',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('사전 파일을 읽지 못해도 빈 값으로 저장할 수 있게 한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const result = await enrichWithKoreanDefinitions([{ word: 'missing' }])

    expect(result.unavailable).toBe(true)
    expect(result.entries).toEqual([{ word: 'missing' }])
  })
})
