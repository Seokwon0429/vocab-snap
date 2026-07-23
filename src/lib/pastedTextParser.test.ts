import { describe, expect, it } from 'vitest'
import { parsePastedVocabularyText } from './pastedTextParser'

describe('붙여넣은 텍스트 분석', () => {
  it('단어·뜻 목록과 일반 영문 문장을 고유 단어 후보로 만든다', () => {
    const result = parsePastedVocabularyText(
      '0001. apple - 사과\nabrupt: 갑작스러운\nI like an apple and a well-known book.',
    )

    expect(result.candidates.slice(0, 2)).toMatchObject([
      { word: 'apple', meaning: '사과', explicitMeaning: true },
      { word: 'abrupt', meaning: '갑작스러운', explicitMeaning: true },
    ])
    expect(result.candidates.map((candidate) => candidate.word)).toContain('well-known')
    expect(result.duplicateWords).toContain('apple')
  })

  it('점 없는 번호와 여러 단어로 된 표현을 뜻과 한 항목으로 연결한다', () => {
    const result = parsePastedVocabularyText([
      '0001 abroad - 해외로',
      '0059 apply for - ~에 지원하다',
      '0137 by -ing - ~함으로써',
      '0173 clichéd - 상투적인',
      '0433 Great Depression - 대공황',
      '0556 link A with B - A와 B를 연결하다',
    ].join('\n'))

    expect(result.candidates).toEqual([
      { word: 'abroad', meaning: '해외로', partOfSpeech: '', explicitMeaning: true },
      { word: 'apply for', meaning: '~에 지원하다', partOfSpeech: '', explicitMeaning: true },
      { word: 'by -ing', meaning: '~함으로써', partOfSpeech: '', explicitMeaning: true },
      { word: 'clichéd', meaning: '상투적인', partOfSpeech: '', explicitMeaning: true },
      { word: 'great depression', meaning: '대공황', partOfSpeech: '', explicitMeaning: true },
      { word: 'link a with b', meaning: 'A와 B를 연결하다', partOfSpeech: '', explicitMeaning: true },
    ])
  })

  it('한 번에 고유 단어 후보를 최대 2,000개까지 만든다', () => {
    const words = Array.from({ length: 2_001 }, (_, index) => {
      const suffix = Array.from({ length: 3 }, (__, position) =>
        String.fromCharCode(97 + Math.floor(index / (26 ** position)) % 26),
      ).join('')
      return `word${suffix}`
    })

    const result = parsePastedVocabularyText(words.join(' '))

    expect(result.candidates).toHaveLength(2_000)
    expect(result.truncated).toBe(true)
  })
})
