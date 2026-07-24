import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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

describe('카드 퀴즈', () => {
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
})
