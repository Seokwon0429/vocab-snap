import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLocalSpeech } from './useLocalSpeech'

describe('기기 내장 영어 발음', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('원격 음성을 제외하고 로컬 영어 음성만 사용한다', async () => {
    const localVoice = {
      default: false,
      lang: 'en-US',
      localService: true,
      name: 'Local English',
      voiceURI: 'local-en',
    } as SpeechSynthesisVoice
    const remoteVoice = {
      default: true,
      lang: 'en-US',
      localService: false,
      name: 'Remote English',
      voiceURI: 'remote-en',
    } as SpeechSynthesisVoice
    const speak = vi.fn()
    const cancel = vi.fn()
    const speechSynthesis = {
      addEventListener: vi.fn(),
      cancel,
      getVoices: vi.fn(() => [remoteVoice, localVoice]),
      removeEventListener: vi.fn(),
      speak,
    }

    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: speechSynthesis,
    })
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        voice: SpeechSynthesisVoice | null = null
        lang = ''
        rate = 1
        pitch = 1
        constructor(readonly text: string) {}
      },
    )

    const { result } = renderHook(() => useLocalSpeech())
    await waitFor(() => expect(result.current.available).toBe(true))

    act(() => {
      expect(result.current.speak('curious')).toBe(true)
    })

    expect(cancel).toHaveBeenCalled()
    expect(speak).toHaveBeenCalledOnce()
    expect(speak.mock.calls[0][0]).toMatchObject({
      text: 'curious',
      voice: localVoice,
      lang: 'en-US',
    })
  })
})
