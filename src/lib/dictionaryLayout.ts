export interface DictionaryColumnWidths {
  word: number
  memo: number
}

const BASE_WORD_WIDTH = 18
const BASE_MEMO_WIDTH = 22
const MAX_SHIFT = 12
const COMFORTABLE_WORD_LENGTH = 12
const SHIFT_PER_CHARACTER = 0.9

/** Moves table space from memo to word while keeping the total percentage unchanged. */
export function calculateDictionaryColumnWidths(
  words: readonly string[],
): DictionaryColumnWidths {
  const longestWordLength = words.reduce(
    (longest, word) => Math.max(longest, Array.from(word.trim()).length),
    0,
  )
  const shift = Math.min(
    MAX_SHIFT,
    Math.max(0, longestWordLength - COMFORTABLE_WORD_LENGTH) * SHIFT_PER_CHARACTER,
  )

  return {
    word: BASE_WORD_WIDTH + shift,
    memo: BASE_MEMO_WIDTH - shift,
  }
}
