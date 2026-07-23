import { describe, expect, it } from 'vitest'
import type { OcrLineEvidence, OcrWordEvidence } from './ocr'
import { parseNumberedTwoColumnVocabulary } from './numberedVocabularyLayout'

function word(
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  confidence = 94,
): OcrWordEvidence {
  return { text, confidence, bbox: { x0, y0, x1, y1 }, alternatives: [] }
}

function line(words: OcrWordEvidence[]): OcrLineEvidence {
  return {
    text: words.map((item) => item.text).join(' '),
    confidence: Math.min(...words.map((item) => item.confidence)),
    bbox: {
      x0: Math.min(...words.map((item) => item.bbox.x0)),
      y0: Math.min(...words.map((item) => item.bbox.y0)),
      x1: Math.max(...words.map((item) => item.bbox.x1)),
      y1: Math.max(...words.map((item) => item.bbox.y1)),
    },
    words,
  }
}

interface FixtureEntry {
  number: string
  headword: string
  meaning?: string[]
  partOfSpeech?: string
}

function vocabularyPage(entries: readonly FixtureEntry[]): OcrLineEvidence[] {
  const lines: OcrLineEvidence[] = [
    line([word('Duolingo', 215, 40, 290, 60), word('English', 300, 40, 365, 60)]),
  ]

  entries.forEach((entry, index) => {
    const y = 160 + index * 155
    const headwordWidth = Math.max(65, entry.headword.length * 14)
    // Tesseract can merge both visual columns into one OCR line. The parser
    // must use each word box instead of trusting line membership.
    lines.push(line([
      word(entry.number, 108, y, 140, y + 17),
      word(entry.headword, 152, y - 5, 152 + headwordWidth, y + 25),
      word(index % 2 === 0 ? 'n.' : 'v.', 370, y, 392, y + 18),
      word(`${entry.headword}ness`, 400, y, 510, y + 18),
    ]))
    lines.push(line([
      word('[pronunciation]', 152, y + 39, 245, y + 55),
      word('This', 370, y + 50, 405, y + 69),
      word('is', 413, y + 50, 428, y + 69),
      word('an', 436, y + 50, 454, y + 69),
      word('example.', 462, y + 50, 535, y + 69),
    ]))
    if (entry.meaning) {
      lines.push(line([
        word(entry.partOfSpeech ?? 'adj.', 152, y + 76, 182, y + 95),
        ...entry.meaning.map((meaning, meaningIndex) => (
          word(meaning, 190 + meaningIndex * 78, y + 76, 255 + meaningIndex * 78, y + 96)
        )),
        word('그는', 370, y + 78, 405, y + 97),
        word('예문을', 413, y + 78, 460, y + 97),
        word('읽는다.', 468, y + 78, 525, y + 97),
      ]))
    }
  })

  const footerY = 160 + entries.length * 155 + 60
  lines.push(line([word('시원스쿨', 760, footerY, 835, footerY + 20)]))
  return lines
}

describe('번호형 2열 단어장 OCR 레이아웃', () => {
  it('표제어와 왼쪽 뜻만 연결하고 오른쪽 파생어·예문·헤더·footer를 제외한다', () => {
    const result = parseNumberedTwoColumnVocabulary(vocabularyPage([
      { number: '0001', headword: 'abroad', meaning: ['해외로'], partOfSpeech: 'adv.' },
      { number: '0002', headword: 'abrupt', meaning: ['갑작스러운,', '뜻밖의'] },
      { number: '0003', headword: 'academic', meaning: ['학업의,', '학문적인,', '학구적인'] },
      { number: '0004', headword: 'acceptable', meaning: ['받아들일', '수', '있는'] },
      { number: '0005', headword: 'accommodate', meaning: ['수용하다,', '맞추다'], partOfSpeech: 'v.' },
      { number: '0006', headword: 'accountable', meaning: ['책임', '있는,', '설명할', '수', '있는'] },
    ]))

    expect(result.detected).toBe(true)
    if (!result.detected) return

    expect(result.confidence).toBe('high')
    expect(result.anchorCount).toBe(6)
    expect(result.entries.map((entry) => entry.word)).toEqual([
      'abroad',
      'abrupt',
      'academic',
      'acceptable',
      'accommodate',
      'accountable',
    ])
    expect(result.entries[0]).toMatchObject({
      number: '0001',
      meaning: '해외로',
      partOfSpeech: '부사',
    })
    expect(result.entries[1]).toMatchObject({
      meaning: '갑작스러운, 뜻밖의',
      partOfSpeech: '형용사',
    })
    expect(result.entries[4]).toMatchObject({ meaning: '수용하다, 맞추다', partOfSpeech: '동사' })
    expect(result.entries.flatMap((entry) => entry.meaningEvidence).some(
      (evidence) => evidence.text.includes('예문'),
    )).toBe(false)
    expect(result.entries.some((entry) => entry.word.endsWith('ness'))).toBe(false)
  })

  it('뜻이 없는 anchor도 사전 fallback을 위해 보존한다', () => {
    const result = parseNumberedTwoColumnVocabulary(vocabularyPage([
      { number: '0101', headword: 'apple', meaning: ['사과'], partOfSpeech: 'n.' },
      { number: '0102', headword: 'banana' },
      { number: '0103', headword: 'cherry', meaning: ['체리'], partOfSpeech: 'n.' },
    ]))

    expect(result.detected).toBe(true)
    if (!result.detected) return
    expect(result.entries[1]).toMatchObject({ word: 'banana', meaning: '', partOfSpeech: '' })
    expect(result.entries[1].meaningEvidence).toEqual([])
  })

  it('반복 anchor 중 충분한 수에 왼쪽 한글 뜻이 없으면 일반 OCR로 fallback한다', () => {
    const result = parseNumberedTwoColumnVocabulary(vocabularyPage([
      { number: '0301', headword: 'apple', meaning: ['사과'], partOfSpeech: 'n.' },
      { number: '0302', headword: 'banana' },
      { number: '0303', headword: 'cherry', meaning: ['체리'], partOfSpeech: 'n.' },
      { number: '0304', headword: 'date' },
      { number: '0305', headword: 'elderberry' },
    ]))

    expect(result).toMatchObject({
      detected: false,
      reason: 'insufficient-meaning-evidence',
      anchorCount: 5,
    })
  })

  it('같은 시각적 의미 행은 bbox 높이가 흔들려도 왼쪽에서 오른쪽 순서로 읽는다', () => {
    const lines = vocabularyPage([
      { number: '0401', headword: 'first', meaning: ['첫째,', '둘째,', '셋째'] },
      { number: '0402', headword: 'second', meaning: ['두번째'] },
      { number: '0403', headword: 'third', meaning: ['세번째'] },
    ])
    const yOffsets = new Map([['첫째,', 5], ['둘째,', -5], ['셋째', 2]])
    for (const ocrLine of lines) {
      for (const evidence of ocrLine.words) {
        const offset = yOffsets.get(evidence.text)
        if (offset === undefined) continue
        evidence.bbox.y0 += offset
        evidence.bbox.y1 += offset
      }
    }

    const result = parseNumberedTwoColumnVocabulary(lines)

    expect(result.detected).toBe(true)
    if (!result.detected) return
    expect(result.entries[0].meaning).toBe('첫째, 둘째, 셋째')
  })

  it('오른쪽 열 시작점이 행마다 흔들려도 첫 번역 토큰을 뜻에 포함하지 않는다', () => {
    const lines = vocabularyPage([
      { number: '0501', headword: 'apple', meaning: ['사과'] },
      { number: '0502', headword: 'banana', meaning: ['바나나'] },
      { number: '0503', headword: 'cherry', meaning: ['체리'] },
    ])
    const shiftedX = [345, 360, 370]
    let translationIndex = 0
    for (const ocrLine of lines) {
      const firstTranslation = ocrLine.words.find((evidence) => evidence.text === '그는')
      if (!firstTranslation) continue
      const nextX = shiftedX[translationIndex]
      const evidenceWidth = firstTranslation.bbox.x1 - firstTranslation.bbox.x0
      firstTranslation.text = '번역'
      firstTranslation.bbox.x0 = nextX
      firstTranslation.bbox.x1 = nextX + evidenceWidth
      translationIndex += 1
    }

    const result = parseNumberedTwoColumnVocabulary(lines)

    expect(result.detected).toBe(true)
    if (!result.detected) return
    expect(result.rightColumnStart).toBe(345)
    expect(result.entries.map((entry) => entry.meaning)).toEqual(['사과', '바나나', '체리'])
    expect(result.entries.some((entry) => entry.meaning.includes('번역'))).toBe(false)
  })

  it("표제어 내부 아포스트로피와 하이픈을 보존한다", () => {
    const result = parseNumberedTwoColumnVocabulary(vocabularyPage([
      { number: '0201', headword: 'don’t', meaning: ['하지', '않는다'] },
      { number: '0202', headword: 'well‑known', meaning: ['잘', '알려진'] },
      { number: '0203', headword: 'ordinary', meaning: ['평범한'] },
    ]))

    expect(result.detected).toBe(true)
    if (!result.detected) return
    expect(result.entries.map((entry) => entry.word)).toEqual(["don't", 'well-known', 'ordinary'])
  })

  it('번호의 0이 O로 인식된 흔한 OCR 오류를 복구한다', () => {
    const result = parseNumberedTwoColumnVocabulary(vocabularyPage([
      { number: '0001', headword: 'apple', meaning: ['사과'] },
      { number: 'OOO2', headword: 'banana', meaning: ['바나나'] },
      { number: '0003', headword: 'cherry', meaning: ['체리'] },
    ]))

    expect(result.detected).toBe(true)
    if (!result.detected) return
    expect(result.entries.map((entry) => entry.number)).toEqual(['0001', '0002', '0003'])
  })

  it('anchor가 세 개보다 적으면 일반 OCR fallback을 선택한다', () => {
    const result = parseNumberedTwoColumnVocabulary(vocabularyPage([
      { number: '0001', headword: 'apple', meaning: ['사과'] },
      { number: '0002', headword: 'banana', meaning: ['바나나'] },
    ]))

    expect(result).toMatchObject({
      detected: false,
      reason: 'not-enough-anchors',
      anchorCount: 2,
    })
  })

  it('보통 크기의 번호 매긴 일반 문서는 단어장으로 오인하지 않는다', () => {
    const lines = [0, 1, 2].map((index) => {
      const y = 100 + index * 50
      return line([
        word(`000${index + 1}`, 40, y, 75, y + 20),
        word(['Read', 'Write', 'Review'][index], 90, y, 145, y + 20),
        word('chapter', 360, y, 425, y + 20),
      ])
    })

    expect(parseNumberedTwoColumnVocabulary(lines)).toMatchObject({
      detected: false,
      reason: 'inconsistent-anchor-columns',
    })
  })

  it('번호 순서나 오른쪽 열 반복이 불명확하면 고신뢰 결과를 만들지 않는다', () => {
    const inconsistentNumbers = vocabularyPage([
      { number: '0003', headword: 'apple', meaning: ['사과'] },
      { number: '0001', headword: 'banana', meaning: ['바나나'] },
      { number: '0002', headword: 'cherry', meaning: ['체리'] },
    ])
    expect(parseNumberedTwoColumnVocabulary(inconsistentNumbers)).toMatchObject({
      detected: false,
      reason: 'inconsistent-number-sequence',
    })

    const noRightColumn = vocabularyPage([
      { number: '0001', headword: 'apple', meaning: ['사과'] },
      { number: '0002', headword: 'banana', meaning: ['바나나'] },
      { number: '0003', headword: 'cherry', meaning: ['체리'] },
    ]).map((ocrLine) => line(ocrLine.words.filter((item) => item.bbox.x0 < 350)))

    expect(parseNumberedTwoColumnVocabulary(noRightColumn)).toMatchObject({
      detected: false,
      reason: 'not-two-column-layout',
    })
  })
})
