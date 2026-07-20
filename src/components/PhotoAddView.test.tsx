import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addMany } from '../lib/db'
import {
  enrichWithKoreanDefinitions,
  lookupKoreanDefinitions,
} from '../lib/koreanDictionary'
import { recognizeImageText, type OcrResult } from '../lib/ocr'
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

vi.mock('../lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/db')>(),
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
})
