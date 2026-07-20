import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PhotoAddView } from './PhotoAddView'

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
})
