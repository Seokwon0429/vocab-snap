import { describe, expect, it } from 'vitest'
import { flattenOcrWords, scoreOcrPasses } from './ocr'

describe('한·영 OCR 결과 선택', () => {
  it('블록에서 가벼운 단어 근거와 대안을 추출한다', () => {
    const words = flattenOcrWords([
      {
        paragraphs: [
          {
            lines: [
              {
                words: [
                  {
                    text: 'Apple',
                    confidence: 72,
                    bbox: { x0: 1, y0: 2, x1: 30, y1: 20 },
                    choices: [
                      { text: 'Apple', confidence: 72 },
                      { text: 'Apply', confidence: 51 },
                    ],
                  },
                  {
                    text: '한국어',
                    confidence: 88,
                    bbox: { x0: 35, y0: 2, x1: 80, y1: 20 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ])

    expect(words).toEqual([
      {
        text: 'Apple',
        confidence: 72,
        bbox: { x0: 1, y0: 2, x1: 30, y1: 20 },
        alternatives: ['Apply'],
      },
      {
        text: '한국어',
        confidence: 88,
        bbox: { x0: 35, y0: 2, x1: 80, y1: 20 },
        alternatives: [],
      },
    ])
    expect(flattenOcrWords(null)).toEqual([])
  })

  it('한 단어만 높은 결과보다 충분한 글자를 안정적으로 읽은 패스를 고른다', () => {
    const ranked = scoreOcrPasses([
      {
        variant: 'balanced',
        confidence: 99,
        weightedWordConfidence: 99,
        wordCount: 1,
        characterCount: 4,
      },
      {
        variant: 'high-contrast',
        confidence: 82,
        weightedWordConfidence: 84,
        wordCount: 8,
        characterCount: 42,
      },
    ])

    expect(ranked.selectedIndex).toBe(1)
    expect(ranked.summaries[1].score).toBeGreaterThan(ranked.summaries[0].score)
  })

  it('점수가 같으면 덜 강하게 보정한 첫 패스를 유지한다', () => {
    const ranked = scoreOcrPasses([
      {
        variant: 'balanced',
        confidence: 80,
        weightedWordConfidence: 80,
        wordCount: 3,
        characterCount: 15,
      },
      {
        variant: 'high-contrast',
        confidence: 80,
        weightedWordConfidence: 80,
        wordCount: 3,
        characterCount: 15,
      },
    ])

    expect(ranked.selectedIndex).toBe(0)
  })
})
