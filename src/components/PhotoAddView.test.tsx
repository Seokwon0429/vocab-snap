import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recognizeImageText } from '../lib/ocr'
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

const recognizeMock = vi.mocked(recognizeImageText)
const correctionMock = vi.mocked(suggestCorrectionsForWords)

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
})

function mixedOcrResult(word = 'rnodern', confidence = 55) {
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
})
