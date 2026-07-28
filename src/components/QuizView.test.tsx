import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WordEntry } from '../types'
import { QuizView } from './QuizView'

const entry: WordEntry = {
  id: 'quiz-1',
  word: 'curious',
  normalizedWord: 'curious',
  meaning: '호기심이 많은',
  partOfSpeech: '형용사',
  memo: 'curious about space',
  folderId: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  quizStats: {
    attempts: 0,
    knownCount: 0,
    unknownCount: 0,
    lastResult: null,
    lastReviewedAt: null,
  },
}

const secondEntry: WordEntry = {
  ...entry,
  id: 'quiz-2',
  word: 'diligent',
  normalizedWord: 'diligent',
  meaning: '부지런한',
}

describe('카드 퀴즈', () => {
  afterEach(() => vi.restoreAllMocks())

  it('뜻을 공개한 뒤 학습 결과를 기록한다', async () => {
    const user = userEvent.setup()
    const onRate = vi.fn(async () => undefined)
    render(
      <QuizView
        entries={[entry]}
        onRate={onRate}
        onSpeak={vi.fn()}
        speechAvailable
      />,
    )

    const startButton = screen.getByRole('button', { name: '1개로 퀴즈 시작' })
    await waitFor(() => expect(startButton).toBeEnabled())
    await user.click(startButton)

    expect(screen.queryByText('호기심이 많은')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /뜻 확인하기/ }))
    expect(screen.getByText('호기심이 많은')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /알아요/ }))

    expect(onRate).toHaveBeenCalledWith(entry, 'known')
    expect(await screen.findByText('오늘 학습을 마쳤어요!')).toBeInTheDocument()
  })

  it('퀴즈가 끝나면 몰랐던 단어만 섞어 다시 풀 수 있다', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const user = userEvent.setup()
    const onRate = vi.fn(async () => undefined)
    render(
      <QuizView
        entries={[entry, secondEntry]}
        onRate={onRate}
        onSpeak={vi.fn()}
        speechAvailable
      />,
    )

    const startButton = screen.getByRole('button', { name: '2개로 퀴즈 시작' })
    await waitFor(() => expect(startButton).toBeEnabled())
    await user.click(startButton)

    expect(screen.getByRole('heading', { name: entry.word })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /뜻 확인하기/ }))
    await user.click(screen.getByRole('button', { name: /아직 몰라요/ }))

    expect(await screen.findByRole('heading', { name: secondEntry.word })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /뜻 확인하기/ }))
    await user.click(screen.getByRole('button', { name: /알아요/ }))

    const retryMissedButton = await screen.findByRole('button', {
      name: '몰랐던 1개만 다시 풀기',
    })
    await user.click(retryMissedButton)

    expect(screen.getByRole('heading', { name: entry.word })).toBeInTheDocument()
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
    expect(screen.getByText(/몰랐던 단어 1개를 다시 섞어 복습/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /뜻 확인하기/ }))
    await user.click(screen.getByRole('button', { name: /알아요/ }))

    expect(await screen.findByText('오늘 학습을 마쳤어요!')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /몰랐던 .* 다시 풀기/ }),
    ).not.toBeInTheDocument()
    expect(onRate).toHaveBeenCalledTimes(3)
  })

  it('전체 단어의 최신 결과만으로 학습률과 암기율을 계산한다', () => {
    const knownEntry: WordEntry = {
      ...entry,
      quizStats: {
        attempts: 10,
        knownCount: 8,
        unknownCount: 2,
        lastResult: 'known',
        lastReviewedAt: '2026-07-27T00:00:00.000Z',
      },
    }
    const unknownEntry: WordEntry = {
      ...secondEntry,
      quizStats: {
        attempts: 12,
        knownCount: 5,
        unknownCount: 7,
        lastResult: 'unknown',
        lastReviewedAt: '2026-07-27T00:00:00.000Z',
      },
    }
    const unstudiedEntry: WordEntry = {
      ...entry,
      id: 'quiz-3',
      word: 'patient',
      normalizedWord: 'patient',
    }
    const props = {
      onRate: vi.fn(async () => undefined),
      onSpeak: vi.fn(),
      speechAvailable: true,
    }
    const { rerender } = render(
      <QuizView entries={[knownEntry, unknownEntry, unstudiedEntry]} {...props} />,
    )

    const stats = screen.getByRole('region', { name: '전체 단어 학습 현황' })
    expect(within(stats).getByText('전체 단어').parentElement).toHaveTextContent('3')
    expect(within(stats).getByText('학습한 단어').parentElement).toHaveTextContent('2')
    expect(within(stats).getByText('알아요').parentElement).toHaveTextContent('1')
    expect(within(stats).getByText('아직 몰라요').parentElement).toHaveTextContent('1')
    expect(within(stats).getByText('학습률').parentElement).toHaveTextContent('67%')
    expect(within(stats).getByText('암기율').parentElement).toHaveTextContent('50%')

    rerender(
      <QuizView
        entries={[
          knownEntry,
          { ...unknownEntry, quizStats: { ...unknownEntry.quizStats, lastResult: 'known' } },
          unstudiedEntry,
        ]}
        {...props}
      />,
    )

    expect(within(stats).getByText('학습한 단어').parentElement).toHaveTextContent('2')
    expect(within(stats).getByText('알아요').parentElement).toHaveTextContent('2')
    expect(within(stats).getByText('아직 몰라요').parentElement).toHaveTextContent('0')
    expect(within(stats).getByText('학습률').parentElement).toHaveTextContent('67%')
    expect(within(stats).getByText('암기율').parentElement).toHaveTextContent('100%')
  })
})
