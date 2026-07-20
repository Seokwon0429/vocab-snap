import { describe, expect, it } from 'vitest'
import {
  boundedDamerauLevenshtein,
  EnglishCorrectionDictionary,
} from './wordCorrection'

function makeDictionary() {
  const known = new Set(['modern', 'mother', 'world', 'word', 'well', 'known', 'teacher'])
  const suggestions = new Map([
    ['rnodern', ['modern', 'mother']],
    ['wrold', ['world', 'word']],
    ['knwon', ['known']],
  ])

  return new EnglishCorrectionDictionary({
    correct: (word) => known.has(word),
    suggest: (word) => suggestions.get(word) ?? [],
    add: (word) => { known.add(word) },
  })
}

describe('로컬 영어 단어 교정', () => {
  it('삽입·치환과 인접 글자 뒤바뀜을 제한 거리 안에서 계산한다', () => {
    expect(boundedDamerauLevenshtein('rnodern', 'modern', 2)).toBe(2)
    expect(boundedDamerauLevenshtein('wrold', 'world', 1)).toBe(1)
    expect(boundedDamerauLevenshtein('apple', 'world', 2)).toBe(3)
  })

  it('사전에 없는 OCR 오인식에만 후보를 제안한다', () => {
    const dictionary = makeDictionary()

    expect(dictionary.suggest('rnodern')[0]?.word).toBe('modern')
    expect(dictionary.suggest('wrold')[0]?.word).toBe('world')
    expect(dictionary.suggest('modern')).toEqual([])
  })

  it('유효한 하이픈 합성어는 유지하고 잘못된 조각만 교정한다', () => {
    const dictionary = makeDictionary()

    expect(dictionary.suggest('well-known')).toEqual([])
    expect(dictionary.suggest('well-knwon')[0]?.word).toBe('well-known')
  })

  it('사용자 단어를 개인 사전에 추가하면 더는 교정을 권하지 않는다', () => {
    const dictionary = makeDictionary()
    dictionary.add('tesseract')

    expect(dictionary.has('tesseract')).toBe(true)
    expect(dictionary.suggest('tesseract')).toEqual([])
  })
})
