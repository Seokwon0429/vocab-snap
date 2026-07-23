import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addMany } from '../lib/storage'
import {
  enrichWithKoreanDefinitions,
  lookupKoreanDefinitions,
} from '../lib/koreanDictionary'
import {
  recognizeImageText,
  type OcrLineEvidence,
  type OcrResult,
  type OcrWordEvidence,
} from '../lib/ocr'
import { suggestCorrectionsForWords } from '../lib/wordCorrection'
import { PhotoAddView } from './PhotoAddView'

vi.mock('../lib/ocr', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/ocr')>(),
  recognizeImageText: vi.fn(),
}))

vi.mock('../lib/wordCorrection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/wordCorrection')>(),
  suggestCorrectionsForWords: vi.fn(),
}))

vi.mock('../lib/storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/storage')>(),
  addMany: vi.fn(),
}))

vi.mock('../lib/koreanDictionary', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/koreanDictionary')>(),
  enrichWithKoreanDefinitions: vi.fn(),
  lookupKoreanDefinitions: vi.fn(),
}))

const recognizeMock = vi.mocked(recognizeImageText)
const correctionMock = vi.mocked(suggestCorrectionsForWords)
const addManyMock = vi.mocked(addMany)
const enrichMock = vi.mocked(enrichWithKoreanDefinitions)
const lookupMock = vi.mocked(lookupKoreanDefinitions)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:preview'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  correctionMock.mockResolvedValue(new Map())
  lookupMock.mockResolvedValue({ definitions: new Map(), unavailable: false })
  enrichMock.mockImplementation(async (entries) => ({
    entries: entries.map((entry) => ({ ...entry })),
    matchedCount: 0,
    unavailable: false,
  }))
  addManyMock.mockResolvedValue({ added: [], duplicates: [] })
})

function mixedOcrResult(word = 'rnodern', confidence = 55): OcrResult {
  return {
    text: `한국어 설명 ${word} 단어`,
    confidence: 81,
    words: [
      {
        text: word,
        confidence,
        bbox: { x0: 1, y0: 1, x1: 40, y1: 20 },
        alternatives: [],
      },
    ],
    selectedVariant: 'balanced' as const,
    passes: [
      {
        variant: 'balanced' as const,
        confidence: 81,
        weightedWordConfidence: confidence,
        score: 72,
        wordCount: 1,
        characterCount: word.length,
      },
    ],
    detectedKorean: true,
    languages: ['eng', 'kor'] as const,
    sourceWidth: 800,
    sourceHeight: 600,
    processedWidth: 800,
    processedHeight: 600,
  }
}

function vocabularyOcrResult(
  word = 'apple',
  meaning = '사과',
  confidence = 92,
): OcrResult {
  const english = {
    text: word,
    confidence,
    bbox: { x0: 10, y0: 10, x1: 90, y1: 36 },
    alternatives: [],
  }
  const korean = {
    text: meaning,
    confidence: 90,
    bbox: { x0: 130, y0: 10, x1: 220, y1: 36 },
    alternatives: [],
  }
  return {
    ...mixedOcrResult(word, confidence),
    text: `${word} : ${meaning}`,
    words: [english, korean],
    lines: [{
      text: `${word} : ${meaning}`,
      confidence: 91,
      bbox: { x0: 10, y0: 10, x1: 220, y1: 36 },
      words: [english, korean],
    }],
  }
}

function pageWord(
  text: string,
  x0: number,
  y0: number,
  width: number,
  height = 20,
  confidence = 92,
): OcrWordEvidence {
  return {
    text,
    confidence,
    bbox: { x0, y0, x1: x0 + width, y1: y0 + height },
    alternatives: [],
  }
}

function pageLine(words: OcrWordEvidence[]): OcrLineEvidence {
  return {
    text: words.map((word) => word.text).join(' '),
    confidence: Math.min(...words.map((word) => word.confidence)),
    bbox: {
      x0: Math.min(...words.map((word) => word.bbox.x0)),
      y0: Math.min(...words.map((word) => word.bbox.y0)),
      x1: Math.max(...words.map((word) => word.bbox.x1)),
      y1: Math.max(...words.map((word) => word.bbox.y1)),
    },
    words,
  }
}

const numberedVocabularyEntries = [
  { number: '0001', word: 'abroad', partOfSpeech: 'adv.', meaningLines: [['해외로']] },
  { number: '0002', word: 'abrupt', partOfSpeech: 'adj.', meaningLines: [['갑작스러운,', '뜻밖의']] },
  { number: '0003', word: 'academic', partOfSpeech: 'adj.', meaningLines: [['학업의,', '학문적인,'], ['학구적인']] },
  { number: '0004', word: 'acceptable', partOfSpeech: 'adj.', meaningLines: [['받아들일', '수', '있는,'], ['인정할', '만한']] },
  { number: '0005', word: 'accommodate', partOfSpeech: 'v.', meaningLines: [['수용하다,', '맞추다']] },
  { number: '0006', word: 'accountable', partOfSpeech: 'adj.', meaningLines: [['책임', '있는,'], ['설명할', '수', '있는']] },
] as const

const numberedVocabularyMeanings = new Map([
  ['abroad', '해외로'],
  ['abrupt', '갑작스러운, 뜻밖의'],
  ['academic', '학업의, 학문적인, 학구적인'],
  ['acceptable', '받아들일 수 있는, 인정할 만한'],
  ['accommodate', '수용하다, 맞추다'],
  ['accountable', '책임 있는, 설명할 수 있는'],
])

function numberedVocabularyOcrResult(): OcrResult {
  const lines: OcrLineEvidence[] = [
    pageLine([
      pageWord('Duolingo', 215, 55, 82, 24),
      pageWord('English', 305, 55, 70, 24),
      pageWord('Test', 383, 55, 42, 24),
    ]),
    pageLine([
      pageWord('기출', 215, 91, 36),
      pageWord('보카', 257, 91, 36),
      pageWord('표제어', 299, 91, 54),
      pageWord('1000개', 360, 91, 60),
    ]),
  ]

  const rightColumn: ReadonlyArray<{
    derivatives: readonly string[]
    example: readonly string[]
    translation: readonly string[]
  }> = [
    {
      derivatives: [],
      example: ["I'd", 'like', 'to', 'go', 'abroad', 'someday.'],
      translation: ['난', '언젠가', '해외로', '가고', '싶다.'],
    },
    {
      derivatives: ['n.', 'abruptness', 'adv.', 'abruptly'],
      example: ['He', 'was', 'confused', 'by', 'the', 'abrupt', 'question.'],
      translation: ['그는', '갑작스러운', '질문에', '혼란스러웠다.'],
    },
    {
      derivatives: ['n.', 'academy,', 'academia', 'adv.', 'academically'],
      example: ['The', 'university', 'is', 'famous', 'for', 'its', 'academic', 'excellence.'],
      translation: ['그', '대학은', '학문적', '우수성으로', '유명하다.'],
    },
    {
      derivatives: ['n.', 'acceptance', 'v.', 'accept,', 'accepted,', 'accepting', 'adv.', 'acceptably'],
      example: ['The', 'agreement', 'was', 'acceptable', 'to', 'both', 'parties.'],
      translation: ['그', '합의는', '양', '당사자가', '받아들일', '수', '있었다.'],
    },
    {
      derivatives: ['n.', 'accommodation', 'v.', 'accommodated,', 'accommodating', 'adj.', 'accommodative'],
      example: ['The', 'government', 'failed', 'to', 'accommodate', 'young', 'people.'],
      translation: ['정부는', '젊은이들을', '수용하는', '데', '실패했다.'],
    },
    {
      derivatives: ['n.', 'accountability', 'v.', 'account,', 'accounted,', 'accounting'],
      example: ['Should', 'parents', 'be', 'held', 'accountable', 'if', 'their', 'children', 'break', 'the', 'law?'],
      translation: ['아이들이', '법을', '어기는', '경우에', '부모가', '책임을', '져야', '하는가?'],
    },
  ]

  numberedVocabularyEntries.forEach((entry, index) => {
    const y = 190 + index * 165
    const headingWords = [
      pageWord(entry.number, 110, y + 7, 36, 18, 95),
      pageWord(entry.word, 153, y, Math.max(70, entry.word.length * 14), 30, 94),
    ]
    let derivativeX = 370
    for (const derivative of rightColumn[index].derivatives) {
      const width = Math.max(22, derivative.length * 9)
      headingWords.push(pageWord(derivative, derivativeX, y + 4, width, 20, 91))
      derivativeX += width + 8
    }
    lines.push(pageLine(headingWords))

    entry.meaningLines.forEach((meaningTokens, meaningIndex) => {
      const meaningY = y + 72 + meaningIndex * 25
      const meaningWords = meaningIndex === 0
        ? [pageWord(entry.partOfSpeech, 153, meaningY, 32, 20, 93)]
        : []
      let meaningX = meaningIndex === 0 ? 191 : 181
      for (const token of meaningTokens) {
        const width = Math.max(18, token.length * 17)
        meaningWords.push(pageWord(token, meaningX, meaningY, width, 21, 93))
        meaningX += width + 8
      }

      if (meaningIndex === 0) {
        let exampleX = 370
        for (const token of rightColumn[index].example) {
          const width = Math.max(18, token.length * 9)
          meaningWords.push(pageWord(token, exampleX, meaningY, width, 18, 91))
          exampleX += width + 7
        }
      }
      lines.push(pageLine(meaningWords))
    })

    let translationX = 370
    const translationWords = rightColumn[index].translation.map((token) => {
      const width = Math.max(18, token.length * 17)
      const word = pageWord(token, translationX, y + 105, width, 18, 90)
      translationX += width + 7
      return word
    })
    lines.push(pageLine(translationWords))
  })

  lines.push(pageLine([pageWord('시원스쿨', 750, 1210, 85, 22), pageWord('LAB', 842, 1206, 52, 28)]))
  const text = lines.map((line) => line.text).join('\n')
  const words = lines.flatMap((line) => line.words)

  return {
    ...mixedOcrResult('abroad', 94),
    text,
    candidateTexts: [text],
    confidence: 92,
    words,
    lines,
    passes: [{
      variant: 'balanced',
      confidence: 92,
      weightedWordConfidence: 92,
      score: 90,
      wordCount: words.length,
      characterCount: text.length,
    }],
    sourceWidth: 1000,
    sourceHeight: 1300,
    processedWidth: 1000,
    processedHeight: 1300,
  }
}

function shortNumberedListOcrResult(): OcrResult {
  const lines = [
    pageLine([pageWord('0001', 110, 180, 36), pageWord('apple', 153, 174, 72, 30)]),
    pageLine([pageWord('사과', 190, 240, 40)]),
    pageLine([pageWord('0002', 110, 340, 36), pageWord('banana', 153, 334, 85, 30)]),
    pageLine([pageWord('바나나', 190, 400, 60)]),
  ]
  const text = '0001 apple 사과\n0002 banana 바나나'
  const words = lines.flatMap((line) => line.words)
  return {
    ...mixedOcrResult('apple', 94),
    text,
    candidateTexts: [text, 'orange'],
    words,
    lines,
    sourceWidth: 800,
    sourceHeight: 600,
    processedWidth: 800,
    processedHeight: 600,
  }
}

async function uploadAndRecognize(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, {
    target: { files: [new File(['image'], 'page.png', { type: 'image/png' })] },
  })
  await userEvent.click(screen.getByRole('button', { name: '한·영 텍스트 인식 시작' }))
}

describe('사진 업로드', () => {
  it('지원하지 않는 파일에 이해하기 쉬운 오류를 표시한다', () => {
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })

    fireEvent.change(input, { target: { files: [file] } })

    expect(screen.getByRole('alert')).toHaveTextContent(/이미지|JPG|PNG/i)
  })

  it('업로드·카메라·드래그 영역을 제공한다', () => {
    render(<PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />)

    expect(screen.getByRole('button', { name: /사진 업로드/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '사진 선택' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '카메라로 촬영' })).toBeInTheDocument()
  })

  it('한국어가 섞인 OCR 원문에서 영어 단어를 검토 화면에 표시한다', async () => {
    recognizeMock.mockResolvedValue(mixedOcrResult('apple', 92))
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByDisplayValue('apple')).toBeInTheDocument()
    expect(screen.getByText('한·영 혼합 인식')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '인식 문장 보기' }))
    expect(screen.getByText(/한국어 설명 apple 단어/)).toBeInTheDocument()
  })

  it('사진에서 같은 행의 한국어 뜻을 표시하고 뜻·품사를 함께 저장한다', async () => {
    recognizeMock.mockResolvedValue(vocabularyOcrResult())
    lookupMock.mockResolvedValue({
      definitions: new Map([['apple', { meaning: '사과; 사과나무 열매', partOfSpeech: '명사' }]]),
      unavailable: false,
    })
    addManyMock.mockResolvedValue({
      added: [{ id: 'apple-id' } as never],
      duplicates: [],
    })
    const onWordsAdded = vi.fn().mockResolvedValue(undefined)
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={onWordsAdded} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByRole('textbox', { name: 'apple 한국어 뜻' })).toHaveValue('사과')
    expect(screen.getByText('사전과 정확히 일치')).toBeInTheDocument()
    expect(screen.getByText('명사')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '선택한 1개 단어 추가' }))

    expect(enrichMock).toHaveBeenCalledWith([{
      word: 'apple',
      meaning: '사과',
      partOfSpeech: '명사',
    }])
    expect(addManyMock).toHaveBeenCalledWith([{
      word: 'apple',
      meaning: '사과',
      partOfSpeech: '명사',
    }])
    expect(onWordsAdded).toHaveBeenCalledWith(1)
  })

  it('사진 뜻이 글자 사이 띄어쓰기로 인식되면 사전 표기로 자동 보정한다', async () => {
    recognizeMock.mockResolvedValue(vocabularyOcrResult('apple', '사 과'))
    lookupMock.mockResolvedValue({
      definitions: new Map([['apple', { meaning: '사과; 사과나무 열매', partOfSpeech: '명사' }]]),
      unavailable: false,
    })
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByRole('textbox', { name: 'apple 한국어 뜻' })).toHaveValue('사과')
    expect(screen.getByText('띄어쓰기 자동 보정·사전 일치')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'apple 선택' })).toBeChecked()
  })

  it('사진 뜻을 사전과 확인하지 못하면 사용자가 선택하기 전까지 저장을 막는다', async () => {
    recognizeMock.mockResolvedValue(vocabularyOcrResult('apple', '바나나'))
    lookupMock.mockResolvedValue({
      definitions: new Map([['apple', { meaning: '사과', partOfSpeech: '명사' }]]),
      unavailable: false,
    })
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    const checkbox = await screen.findByRole('checkbox', { name: 'apple 선택' })
    expect(checkbox).toBeDisabled()
    expect(checkbox).not.toBeChecked()
    expect(screen.getByText('뜻 확인 필요')).toBeInTheDocument()
    expect(screen.getByText('사과')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'apple의 사진 속 한국어 뜻 사용' }))
    expect(checkbox).toBeEnabled()
    expect(checkbox).toBeChecked()
  })

  it('사전과 일부 단어만 겹치는 사진 뜻도 자동 선택하지 않는다', async () => {
    recognizeMock.mockResolvedValue(vocabularyOcrResult('apple', '사과 먹는다'))
    lookupMock.mockResolvedValue({
      definitions: new Map([['apple', { meaning: '사과; 사과나무 열매', partOfSpeech: '명사' }]]),
      unavailable: false,
    })
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByText('사전 뜻과 유사')).toBeInTheDocument()
    const checkbox = screen.getByRole('checkbox', { name: 'apple 선택' })
    expect(checkbox).toBeDisabled()
    expect(checkbox).not.toBeChecked()
  })

  it('사진 품사와 사전 품사가 다르면 뜻이 같아도 확인을 요구한다', async () => {
    const result = vocabularyOcrResult()
    const english = result.lines![0].words[0]
    const korean = result.lines![0].words[1]
    const photographedPos = {
      text: '동사',
      confidence: 90,
      bbox: { x0: 100, y0: 10, x1: 125, y1: 36 },
      alternatives: [],
    }
    result.words = [english, photographedPos, korean]
    result.lines![0].words = [english, photographedPos, korean]
    lookupMock.mockResolvedValue({
      definitions: new Map([['apple', { meaning: '사과', partOfSpeech: '명사' }]]),
      unavailable: false,
    })
    recognizeMock.mockResolvedValue(result)
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByText('뜻 확인 필요')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'apple 선택' })).toBeDisabled()
  })

  it('사용자가 해제한 단어는 뜻을 수정해도 다시 선택하지 않는다', async () => {
    recognizeMock.mockResolvedValue(vocabularyOcrResult())
    lookupMock.mockResolvedValue({
      definitions: new Map([['apple', { meaning: '사과', partOfSpeech: '명사' }]]),
      unavailable: false,
    })
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    const checkbox = await screen.findByRole('checkbox', { name: 'apple 선택' })
    expect(checkbox).toBeChecked()
    await userEvent.click(checkbox)
    await userEvent.clear(screen.getByRole('textbox', { name: 'apple 한국어 뜻' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'apple 한국어 뜻' }), '풋사과')

    expect(checkbox).not.toBeChecked()
  })

  it('뜻을 직접 고친 뒤 영문 교정 후보를 적용해도 수정한 뜻을 보존한다', async () => {
    recognizeMock.mockResolvedValue(vocabularyOcrResult('applf', '사과', 55))
    correctionMock.mockResolvedValue(new Map([
      ['applf', [{ word: 'apple', rank: 1 }]],
    ]))
    lookupMock.mockResolvedValue({
      definitions: new Map([['apple', { meaning: '사과', partOfSpeech: '명사' }]]),
      unavailable: false,
    })
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    const meaningInput = await screen.findByRole('textbox', { name: 'applf 한국어 뜻' })
    await userEvent.clear(meaningInput)
    await userEvent.type(meaningInput, '먹는 사과')
    await userEvent.click(screen.getByRole('button', { name: 'applf를 apple로 수정' }))

    expect(screen.getByRole('textbox', { name: 'apple 한국어 뜻' })).toHaveValue('먹는 사과')
    expect(screen.getByRole('button', { name: 'apple의 현재 한국어 뜻 사용' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'apple 선택' })).toBeDisabled()
  })

  it('비동기 사전 확인 중 철자를 다시 바꾸면 이전 단어 뜻을 적용하지 않는다', async () => {
    const delayedLookup = deferred<Awaited<ReturnType<typeof lookupKoreanDefinitions>>>()
    lookupMock
      .mockResolvedValueOnce({ definitions: new Map(), unavailable: false })
      .mockReturnValueOnce(delayedLookup.promise)
    recognizeMock.mockResolvedValue(mixedOcrResult('w0rd', 94))
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)
    const wordInput = await screen.findByDisplayValue('w0rd')
    await userEvent.clear(wordInput)
    await userEvent.type(wordInput, 'modern')
    await userEvent.click(screen.getByRole('button', { name: 'w0rd 수정 확인' }))
    await userEvent.clear(wordInput)
    await userEvent.type(wordInput, 'apple')
    delayedLookup.resolve({
      definitions: new Map([['modern', { meaning: '현대의', partOfSpeech: '형용사' }]]),
      unavailable: false,
    })

    await waitFor(() => {
      expect(screen.getByText('단어가 다시 수정되어 최신 철자를 기준으로 확인해 주세요.')).toBeInTheDocument()
    })
    expect(wordInput).toHaveValue('apple')
    expect(screen.queryByDisplayValue('현대의')).not.toBeInTheDocument()
  })

  it('낮은 신뢰도 단어는 자동 선택하지 않고 교정 후보를 사용자가 적용한다', async () => {
    recognizeMock.mockResolvedValue(mixedOcrResult())
    correctionMock.mockResolvedValue(new Map([
      ['rnodern', [{ word: 'modern', rank: 1 }]],
    ]))
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    const checkbox = await screen.findByRole('checkbox', { name: 'rnodern 선택' })
    expect(checkbox).not.toBeChecked()
    expect(checkbox).toBeDisabled()
    expect(screen.getByRole('group', { name: 'rnodern 교정' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'rnodern를 modern로 수정' }))

    expect(screen.getByDisplayValue('modern')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'modern 선택' })).toBeChecked()
  })

  it('20% 미만 단어는 검토 화면에서 완전히 제외한다', async () => {
    const result = mixedOcrResult('banana', 86)
    result.text = 'banana apple'
    result.words.push({
      text: 'apple',
      confidence: 19,
      bbox: { x0: 50, y0: 1, x1: 95, y1: 20 },
      alternatives: [],
    })
    recognizeMock.mockResolvedValue(result)
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByDisplayValue('banana')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('apple')).not.toBeInTheDocument()
    expect(screen.getByText('20% 미만 1개 제외')).toBeInTheDocument()
  })

  it('40~49% 단어는 일반 후보 뒤의 별도 검토 영역에 표시한다', async () => {
    const result = mixedOcrResult('banana', 86)
    result.text = 'banana maybe'
    result.words.push({
      text: 'maybe',
      confidence: 48,
      bbox: { x0: 50, y0: 1, x1: 95, y1: 20 },
      alternatives: [],
    })
    recognizeMock.mockResolvedValue(result)
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    const normalWord = await screen.findByDisplayValue('banana')
    const divider = screen.getByText('낮은 인식률 후보 · 별도 검토')
    const lowWord = screen.getByDisplayValue('maybe')
    expect(normalWord.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(divider.compareDocumentPosition(lowWord) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText(/40~49%는 철자를 확인/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'maybe 선택' })).toBeDisabled()
  })

  it('20~39% 단어는 별도 영역에서 오류 가능성이 매우 높다고 경고한다', async () => {
    recognizeMock.mockResolvedValue(mixedOcrResult('maybe', 35))
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByText('인식률이 매우 낮아요.')).toBeInTheDocument()
    expect(screen.getByText('35%')).toHaveClass('is-critical')
  })

  it('교정 후보가 없어도 원문 유지를 명시하면 선택할 수 있다', async () => {
    recognizeMock.mockResolvedValue(mixedOcrResult('vocab', 60))
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)
    await screen.findByDisplayValue('vocab')
    await userEvent.click(screen.getByRole('button', { name: '원문 유지' }))

    expect(screen.getByDisplayValue('vocab')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'vocab 선택' })).toBeChecked()
  })

  it('선택된 문장에는 없지만 다른 OCR 원문에 있는 후보도 확인 항목으로 표시한다', async () => {
    const result = mixedOcrResult('apple', 94)
    result.candidateTexts = [result.text, 'banana']
    recognizeMock.mockResolvedValue(result)
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByDisplayValue('banana')).toBeInTheDocument()
    const checkbox = screen.getByRole('checkbox', { name: 'banana 선택' })
    expect(checkbox).not.toBeChecked()
    expect(checkbox).toBeDisabled()
    expect(screen.getByText(/추가 회수 1개/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '원문 유지' }))
    expect(screen.getByRole('checkbox', { name: 'banana 선택' })).toBeChecked()
  })

  it('숫자가 섞여 엄격한 필터에서 빠진 OCR 조각도 직접 고칠 수 있게 노출한다', async () => {
    const result = mixedOcrResult('apple', 94)
    result.words.push({
      text: 'w0rd',
      confidence: 48,
      bbox: { x0: 50, y0: 1, x1: 95, y1: 20 },
      alternatives: [],
    })
    recognizeMock.mockResolvedValue(result)
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    const candidate = await screen.findByDisplayValue('w0rd')
    expect(screen.getByText('추가 확인이 필요한 후보')).toBeInTheDocument()
    await userEvent.clear(candidate)
    await userEvent.type(candidate, 'word')
    expect(candidate).toHaveValue('word')
    await userEvent.click(screen.getByRole('button', { name: 'w0rd 수정 확인' }))

    expect(screen.getByRole('checkbox', { name: 'word 선택' })).toBeChecked()
  })

  it('같은 위치의 다른 패스가 제안한 정상 단어를 불확실 조각에 적용한다', async () => {
    const result = mixedOcrResult('apple', 94)
    result.words.push({
      text: 'w0rd',
      confidence: 48,
      bbox: { x0: 50, y0: 1, x1: 95, y1: 20 },
      alternatives: ['word'],
      recoveredFromAlternatePass: true,
    })
    recognizeMock.mockResolvedValue(result)
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)
    await screen.findByDisplayValue('w0rd')
    await userEvent.click(screen.getByRole('button', { name: 'w0rd를 word로 수정' }))

    expect(screen.getByDisplayValue('word')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'word 선택' })).toBeChecked()
  })

  it('번호형 2열 단어장은 표제어와 왼쪽 뜻만 검토 대상으로 제한한다', async () => {
    const result = numberedVocabularyOcrResult()
    recognizeMock.mockResolvedValue(result)
    lookupMock.mockResolvedValue({
      definitions: new Map([
        ['abroad', { meaning: '국외로', partOfSpeech: '부사' }],
        ['abrupt', { meaning: '갑작스러운, 뜻밖의', partOfSpeech: '형용사' }],
        ['academic', { meaning: '학업의, 학문적인, 학구적인', partOfSpeech: '형용사' }],
        ['acceptable', { meaning: '받아들일 수 있는, 인정할 만한', partOfSpeech: '형용사' }],
        ['accommodate', { meaning: '수용하다, 맞추다', partOfSpeech: '동사' }],
        ['accountable', { meaning: '책임 있는, 설명할 수 있는', partOfSpeech: '형용사' }],
      ]),
      unavailable: false,
    })
    addManyMock.mockResolvedValue({
      added: numberedVocabularyEntries.map((entry) => ({ id: `${entry.word}-id` } as never)),
      duplicates: [],
    })
    const onWordsAdded = vi.fn().mockResolvedValue(undefined)
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={onWordsAdded} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)
    await screen.findByDisplayValue('abroad')

    expect(screen.getByText('번호형 단어장 · 표제어 6개')).toBeInTheDocument()
    expect(screen.getByText(/본문·파생어 후보 \d+개 제외/)).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox', { name: / 선택$/ })).toHaveLength(6)
    for (const entry of numberedVocabularyEntries) {
      expect(screen.getByDisplayValue(entry.word)).toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: `${entry.word} 한국어 뜻` }))
        .toHaveValue(numberedVocabularyMeanings.get(entry.word))
    }
    for (const excluded of [
      'duolingo',
      'english',
      'test',
      'abruptness',
      'academia',
      'academically',
      'acceptance',
      'accept',
      'accepted',
      'accommodation',
      'accountability',
      'government',
      'question',
      'lab',
    ]) {
      expect(screen.queryByDisplayValue(excluded)).not.toBeInTheDocument()
    }
    expect(screen.queryAllByText('여러 번 발견')).toHaveLength(0)
    expect(correctionMock).toHaveBeenCalledTimes(1)
    expect([...correctionMock.mock.calls[0][0]].map(({ word }) => word)).toEqual(
      numberedVocabularyEntries.map((entry) => entry.word),
    )

    const abroadCheckbox = screen.getByRole('checkbox', { name: 'abroad 선택' })
    expect(abroadCheckbox).toBeDisabled()
    expect(abroadCheckbox).not.toBeChecked()
    expect(screen.getByRole('button', { name: '선택한 5개 단어 추가' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'abroad의 사진 속 한국어 뜻 사용' }))
    expect(abroadCheckbox).toBeEnabled()
    expect(abroadCheckbox).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: '인식 문장 보기' }))
    expect(screen.getByText((_, element) => (
      element?.tagName === 'PRE'
      && Boolean(element.textContent?.includes('He was confused by the abrupt question.'))
    ))).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '선택한 6개 단어 추가' }))

    await waitFor(() => {
      expect(addManyMock).toHaveBeenCalledWith(
        numberedVocabularyEntries.map((entry) => ({
          word: entry.word,
          meaning: numberedVocabularyMeanings.get(entry.word),
          partOfSpeech: entry.partOfSpeech === 'v.'
            ? '동사'
            : entry.partOfSpeech === 'adv.'
              ? '부사'
              : '형용사',
        })),
      )
    })
    expect(onWordsAdded).toHaveBeenCalledWith(6)
  })

  it('번호형 표제어는 같은 위치의 다른 OCR 패스 신뢰도와 교정 대안을 사용한다', async () => {
    const result = numberedVocabularyOcrResult()
    const selectedAnchor = result.lines
      ?.flatMap((line) => line.words)
      .find((word) => word.text === 'abroad' && word.bbox.x0 < 300)
    if (!selectedAnchor) throw new Error('테스트 표제어 증거가 없습니다.')

    selectedAnchor.text = 'abrroad'
    selectedAnchor.confidence = 10
    result.words = result.words.map((word) => (
      word === selectedAnchor
        ? { ...word, confidence: 90, alternatives: ['abroad'] }
        : word
    ))
    result.words.push({
      text: 'intruder',
      confidence: 99,
      bbox: { x0: 760, y0: 140, x1: 840, y1: 162 },
      alternatives: [],
      recoveredFromAlternatePass: true,
    })
    recognizeMock.mockResolvedValue(result)
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByDisplayValue('abrroad')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('intruder')).not.toBeInTheDocument()
    expect(screen.queryByText('20% 미만 1개 제외')).not.toBeInTheDocument()
    expect(screen.getByText('90%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'abrroad를 abroad로 수정' })).toBeInTheDocument()
  })

  it('번호 항목이 두 개뿐이면 일반 추출과 다른 OCR 패스 후보 회수를 유지한다', async () => {
    recognizeMock.mockResolvedValue(shortNumberedListOcrResult())
    const { container } = render(
      <PhotoAddView entries={[]} onWordsAdded={vi.fn()} notify={vi.fn()} />,
    )

    await uploadAndRecognize(container)

    expect(await screen.findByDisplayValue('apple')).toBeInTheDocument()
    expect(screen.getByDisplayValue('banana')).toBeInTheDocument()
    expect(screen.getByDisplayValue('orange')).toBeInTheDocument()
    expect(screen.getByText('추가 회수 1개')).toBeInTheDocument()

    const recoveredCheckbox = screen.getByRole('checkbox', { name: 'orange 선택' })
    expect(recoveredCheckbox).toBeDisabled()
    expect(recoveredCheckbox).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: '원문 유지' }))
    expect(recoveredCheckbox).toBeEnabled()
    expect(recoveredCheckbox).toBeChecked()
  })
})
