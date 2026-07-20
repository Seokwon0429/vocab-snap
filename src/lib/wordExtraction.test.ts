import { describe, expect, it } from 'vitest'
import { extractEnglishWords, normalizeEnglishWord } from './wordExtraction'

describe('영어 단어 추출', () => {
  it('아포스트로피와 유니코드 하이픈을 보존하고 대소문자 중복을 합친다', () => {
    const result = extractEnglishWords(
      "Don't DON’T well‑known mother-in-law Apple apple I a",
    )

    expect(result.words).toEqual([
      "don't",
      'well-known',
      'mother-in-law',
      'apple',
      'i',
      'a',
    ])
    expect(result.duplicateWords).toEqual(["don't", 'apple'])
  })

  it('숫자 혼합 문자열과 명백한 OCR 잡음을 제외한다', () => {
    const result = extractEnglishWords('useful w0rd 123 llll bcdfghjk real')

    expect(result.words).toEqual(['useful', 'real'])
    expect(result.rejected).toEqual(expect.arrayContaining(['w0rd', '123', 'llll', 'bcdfghjk']))
  })

  it('기존 단어장 항목을 신규 단어와 분리한다', () => {
    const result = extractEnglishWords('Apple orange ORANGE pear', {
      existingWords: ['apple', 'Pear'],
    })

    expect(result.newWords).toEqual(['orange'])
    expect(result.existingWords).toEqual(['apple', 'pear'])
  })

  it('한 단어가 아닌 수정 문자열을 거부한다', () => {
    expect(normalizeEnglishWord('two words')).toBe('')
    expect(normalizeEnglishWord("O’Reilly")).toBe("o'reilly")
  })
})
