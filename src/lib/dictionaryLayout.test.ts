import { describe, expect, it } from 'vitest'
import { calculateDictionaryColumnWidths } from './dictionaryLayout'

describe('단어장 표 열 너비', () => {
  it('짧은 단어만 있으면 기본 너비를 유지한다', () => {
    expect(calculateDictionaryColumnWidths(['apple', 'banana'])).toEqual({
      word: 18,
      memo: 22,
    })
  })

  it('긴 단어가 있으면 메모 너비를 단어 열로 옮긴다', () => {
    expect(calculateDictionaryColumnWidths(['apple', 'misunderstanding'])).toEqual({
      word: 21.6,
      memo: 18.4,
    })
  })

  it('매우 긴 단어여도 메모 열을 최소 10퍼센트 남긴다', () => {
    expect(calculateDictionaryColumnWidths(['pneumonoultramicroscopicsilicovolcanoconiosis'])).toEqual({
      word: 30,
      memo: 10,
    })
  })
})
