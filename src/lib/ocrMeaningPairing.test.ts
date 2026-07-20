import { describe, expect, it } from 'vitest'
import type { OcrLineEvidence, OcrWordEvidence } from './ocr'
import {
  compareOcrMeaningWithDictionary,
  correctOcrKoreanSpacing,
  findCrossSwappedMeaningWords,
  pairOcrLinesWithKoreanMeanings,
  type OcrMeaningCandidate,
} from './ocrMeaningPairing'

function evidence(
  text: string,
  x0: number,
  x1: number,
  confidence = 92,
  y0 = 10,
): OcrWordEvidence {
  return {
    text,
    confidence,
    bbox: { x0, y0, x1, y1: y0 + 22 },
    alternatives: [],
  }
}

function line(words: OcrWordEvidence[], text = words.map((word) => word.text).join(' ')): OcrLineEvidence {
  return {
    text,
    confidence: 90,
    bbox: {
      x0: words[0].bbox.x0,
      y0: Math.min(...words.map((word) => word.bbox.y0)),
      x1: words.at(-1)!.bbox.x1,
      y1: Math.max(...words.map((word) => word.bbox.y1)),
    },
    words,
  }
}

describe('사진 속 영어 단어와 한국어 뜻 연결', () => {
  it('반복되는 영어-한국어 행을 각각 연결한다', () => {
    const pairs = pairOcrLinesWithKoreanMeanings([
      line([evidence('apple', 10, 70), evidence('사과', 110, 155)]),
      line([evidence('banana', 10, 82, 92, 50), evidence('바나나', 110, 175, 92, 50)]),
    ])

    expect(pairs.get('apple')).toMatchObject({
      meaning: '사과',
      layoutConfidence: 'strong',
    })
    expect(pairs.get('banana')).toMatchObject({
      meaning: '바나나',
      layoutConfidence: 'strong',
    })
  })

  it('표의 한영 셀이 같은 높이의 별도 OCR 줄이어도 행으로 합친다', () => {
    const pairs = pairOcrLinesWithKoreanMeanings([
      line([evidence('apple', 10, 70, 92, 10)]),
      line([evidence('사과', 110, 155, 90, 10)]),
      line([evidence('banana', 10, 82, 92, 50)]),
      line([evidence('바나나', 110, 175, 90, 50)]),
    ])

    expect(pairs.get('apple')).toMatchObject({ meaning: '사과', layoutConfidence: 'strong' })
    expect(pairs.get('banana')).toMatchObject({ meaning: '바나나', layoutConfidence: 'strong' })
  })

  it('한국어가 먼저 나오는 행과 품사 표기도 처리한다', () => {
    const pairs = pairOcrLinesWithKoreanMeanings([
      line([
        evidence('명사', 10, 45),
        evidence('사과', 50, 90),
        evidence('apple', 130, 190),
      ], '명사 사과 : apple'),
    ])

    expect(pairs.get('apple')).toMatchObject({
      meaning: '사과',
      partOfSpeech: '명사',
      layoutConfidence: 'strong',
    })
  })

  it('영문 품사 약어와 이름을 별도 단어가 아닌 품사로 연결한다', () => {
    const pairs = pairOcrLinesWithKoreanMeanings([
      line([
        evidence('beautiful', 10, 82),
        evidence('adj.', 88, 118),
        evidence('아름다운', 140, 210),
        evidence('run', 250, 285),
        evidence('verb', 292, 330),
        evidence('달리다', 350, 405),
      ]),
    ])

    expect(pairs.get('beautiful')).toMatchObject({
      meaning: '아름다운',
      partOfSpeech: '형용사',
    })
    expect(pairs.get('run')).toMatchObject({
      meaning: '달리다',
      partOfSpeech: '동사',
    })
    expect(pairs.has('adj')).toBe(false)
    expect(pairs.has('verb')).toBe(false)
  })

  it('한글 뜻이 한 음절씩 별도 OCR 조각으로 나뉘어도 후보를 보존한다', () => {
    const pairs = pairOcrLinesWithKoreanMeanings([
      line([
        evidence('apple', 10, 70),
        evidence('사', 110, 125),
        evidence('과', 130, 145),
      ], 'apple : 사 과'),
    ])

    expect(pairs.get('apple')).toMatchObject({ meaning: '사 과' })
  })

  it('noun 자체가 표제어인 행은 품사 메타데이터로 오인하지 않는다', () => {
    const pairs = pairOcrLinesWithKoreanMeanings([
      line([evidence('noun', 10, 60), evidence('명사', 100, 145)], 'noun : 명사'),
    ])

    expect(pairs.get('noun')).toMatchObject({ meaning: '명사' })
  })

  it('품사 이름 자체인 표제어가 다른 단어와 같은 행에 있어도 둘 다 연결한다', () => {
    const pairs = pairOcrLinesWithKoreanMeanings([
      line([
        evidence('noun', 10, 60),
        evidence('명사', 80, 125),
        evidence('apple', 165, 225),
        evidence('사과', 245, 290),
      ]),
    ])

    expect(pairs.get('noun')).toMatchObject({ meaning: '명사' })
    expect(pairs.get('apple')).toMatchObject({ meaning: '사과' })
  })

  it('영어 예문과 영어에 붙은 한국어 조사는 뜻으로 연결하지 않는다', () => {
    const pairs = pairOcrLinesWithKoreanMeanings([
      line([
        evidence('eat', 10, 40),
        evidence('an', 48, 68),
        evidence('apple', 75, 130),
        evidence('나는', 170, 210),
        evidence('사과를', 218, 270),
        evidence('먹는다', 278, 330),
      ]),
      line([evidence('apple을', 10, 75), evidence('외운다', 100, 155)]),
    ])

    expect(pairs.size).toBe(0)
  })

  it('같은 단어가 서로 다른 뜻과 연결되면 자동 후보를 만들지 않는다', () => {
    const pairs = pairOcrLinesWithKoreanMeanings([
      line([evidence('bank', 10, 60), evidence('은행', 100, 145)]),
      line([evidence('bank', 10, 60, 92, 50), evidence('제방', 100, 145, 92, 50)]),
    ])

    expect(pairs.has('bank')).toBe(false)
  })
})

describe('사진 뜻과 내장 사전 비교', () => {
  const strongCandidate: OcrMeaningCandidate = {
    word: 'apple',
    meaning: '사과',
    partOfSpeech: '',
    confidence: 90,
    layoutConfidence: 'strong',
  }

  it('사전 뜻 조각과 정확히 같으면 정확한 일치로 판정한다', () => {
    expect(compareOcrMeaningWithDictionary(strongCandidate, {
      meaning: '사과; 사과나무 열매',
      partOfSpeech: '명사',
    })).toBe('exact')
  })

  it('한글 OCR이 글자 사이를 잘못 띄우면 일치하는 사전 표기로 보정한다', () => {
    const dictionary = {
      meaning: '사과; 사과나무 열매',
      partOfSpeech: '명사',
    }
    const spacedCandidate = { ...strongCandidate, meaning: '사 과' }

    expect(correctOcrKoreanSpacing(spacedCandidate.meaning, dictionary)).toBe('사과')
    expect(compareOcrMeaningWithDictionary(spacedCandidate, dictionary)).toBe('exact')
  })

  it('띄어쓰기 외의 글자가 다르면 사전 뜻으로 바꾸지 않는다', () => {
    expect(correctOcrKoreanSpacing('바 나 나', {
      meaning: '사과',
      partOfSpeech: '명사',
    })).toBe('바 나 나')
  })

  it('사전 설명 속 핵심 단어가 같으면 유사, 근거가 없으면 확인 필요로 판정한다', () => {
    expect(compareOcrMeaningWithDictionary(strongCandidate, {
      meaning: '(식물) 사과나무에서 자라는 열매 사과',
      partOfSpeech: '명사',
    })).toBe('related')
    expect(compareOcrMeaningWithDictionary(strongCandidate, {
      meaning: '바나나',
      partOfSpeech: '명사',
    })).toBe('uncertain')
    expect(compareOcrMeaningWithDictionary(strongCandidate, undefined)).toBe('uncertain')
  })

  it('두 행의 뜻이 서로 정확히 뒤바뀐 경우만 교차 오류로 찾는다', () => {
    const candidates = new Map<string, OcrMeaningCandidate>([
      ['apple', { ...strongCandidate, word: 'apple', meaning: '바나나' }],
      ['banana', { ...strongCandidate, word: 'banana', meaning: '사과' }],
    ])
    const definitions = new Map([
      ['apple', { meaning: '사과', partOfSpeech: '명사' }],
      ['banana', { meaning: '바나나', partOfSpeech: '명사' }],
    ])

    expect(findCrossSwappedMeaningWords(candidates, definitions)).toEqual(
      new Set(['apple', 'banana']),
    )
  })
})
