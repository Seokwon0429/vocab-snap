import { describe, expect, it } from 'vitest'
import {
  calculateTargetSize,
  consolidateOcrWordEvidence,
  flattenOcrWords,
  scoreOcrPasses,
} from './ocr'

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

  it('긴 페이지는 6MP 제한을 유지하면서 2400px보다 길게 보존한다', () => {
    const tallPage = calculateTargetSize(1200, 8000, {
      maxDimension: 4096,
      maxPixels: 6_000_000,
    })
    const standardPage = calculateTargetSize(3024, 4032, {
      maxDimension: 4096,
      maxPixels: 6_000_000,
    })

    expect(tallPage.height).toBe(4096)
    expect(tallPage.width).toBeGreaterThan(360)
    expect(tallPage.width * tallPage.height).toBeLessThanOrEqual(6_000_000)
    expect(Math.max(standardPage.width, standardPage.height)).toBeGreaterThan(2400)
    expect(standardPage.width * standardPage.height).toBeLessThanOrEqual(6_000_000)
  })

  it('선택되지 않은 패스의 새 위치 단어는 복구하고 같은 위치 문자는 대안으로 합친다', () => {
    const consolidated = consolidateOcrWordEvidence(
      [
        {
          text: 'apple',
          confidence: 82,
          bbox: { x0: 10, y0: 10, x1: 80, y1: 35 },
          alternatives: [],
        },
      ],
      [
        {
          text: 'app1e',
          confidence: 65,
          bbox: { x0: 11, y0: 10, x1: 79, y1: 35 },
          alternatives: [],
        },
        {
          text: 'banana',
          confidence: 71,
          bbox: { x0: 95, y0: 10, x1: 175, y1: 35 },
          alternatives: [],
        },
      ],
    )

    expect(consolidated).toHaveLength(2)
    expect(consolidated[0]).toMatchObject({
      text: 'apple',
      alternatives: ['app1e'],
      recoveredFromAlternatePass: false,
    })
    expect(consolidated[1]).toMatchObject({
      text: 'banana',
      recoveredFromAlternatePass: true,
    })
  })

  it('다른 패스의 실제 인식값을 기존 choice보다 우선하고 정규화가 같으면 신뢰도를 합친다', () => {
    const correction = consolidateOcrWordEvidence(
      [{
        text: 'rnodern',
        confidence: 54,
        bbox: { x0: 5, y0: 5, x1: 90, y1: 30 },
        alternatives: ['random', 'render', 'reader'],
      }],
      [{
        text: 'modern',
        confidence: 88,
        bbox: { x0: 6, y0: 5, x1: 89, y1: 30 },
        alternatives: [],
      }],
    )
    const normalizedMatch = consolidateOcrWordEvidence(
      [{
        text: 'Apple',
        confidence: 55,
        bbox: { x0: 5, y0: 5, x1: 60, y1: 30 },
        alternatives: [],
      }],
      [{
        text: 'apple',
        confidence: 93,
        bbox: { x0: 5, y0: 5, x1: 60, y1: 30 },
        alternatives: [],
      }],
    )

    expect(correction[0].alternatives).toEqual(['modern', 'random', 'render'])
    expect(normalizedMatch[0]).toMatchObject({ confidence: 93, alternatives: [] })
  })

  it('한 큰 상자와 여러 작은 상자의 분할 차이는 대안으로 흡수하지 않는다', () => {
    const consolidated = consolidateOcrWordEvidence(
      [{
        text: 'inthe',
        confidence: 62,
        bbox: { x0: 0, y0: 0, x1: 110, y1: 24 },
        alternatives: [],
      }],
      [
        {
          text: 'in',
          confidence: 86,
          bbox: { x0: 0, y0: 0, x1: 42, y1: 24 },
          alternatives: [],
        },
        {
          text: 'the',
          confidence: 90,
          bbox: { x0: 48, y0: 0, x1: 110, y1: 24 },
          alternatives: [],
        },
      ],
    )

    expect(consolidated.map((word) => word.text)).toEqual(['inthe', 'in', 'the'])
    expect(consolidated.slice(1).every((word) => word.recoveredFromAlternatePass)).toBe(true)
  })
})
