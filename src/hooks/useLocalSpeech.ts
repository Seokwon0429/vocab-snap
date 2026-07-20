import { useCallback, useEffect, useState } from 'react'

export interface LocalSpeechController {
  available: boolean
  loading: boolean
  speak: (word: string) => boolean
  stop: () => void
}

export function useLocalSpeech(): LocalSpeechController {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!('speechSynthesis' in window)) {
      setLoading(false)
      return
    }

    const pickLocalEnglishVoice = () => {
      const voices = window.speechSynthesis.getVoices()
      const englishVoices = voices.filter(
        (candidate) =>
          candidate.localService && candidate.lang.toLowerCase().startsWith('en'),
      )
      const preferred =
        englishVoices.find((candidate) => /natural|samantha|zira/i.test(candidate.name)) ??
        englishVoices.find((candidate) => candidate.default) ??
        englishVoices[0] ??
        null
      setVoice(preferred)
      setLoading(false)
    }

    pickLocalEnglishVoice()
    window.speechSynthesis.addEventListener('voiceschanged', pickLocalEnglishVoice)
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', pickLocalEnglishVoice)
      window.speechSynthesis.cancel()
    }
  }, [])

  const speak = useCallback(
    (word: string) => {
      if (!voice || !word.trim()) return false
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(word)
      utterance.voice = voice
      utterance.lang = voice.lang
      utterance.rate = 0.82
      utterance.pitch = 1
      window.speechSynthesis.speak(utterance)
      return true
    },
    [voice],
  )

  const stop = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  return { available: Boolean(voice), loading, speak, stop }
}
