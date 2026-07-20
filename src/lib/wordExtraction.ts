const TYPOGRAPHIC_APOSTROPHES = /[\u2018\u2019\u201B\u02BC\u02BB\uFF07\u00B4`]/g;
const TYPOGRAPHIC_DASHES = /[\u00AD\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const TOKEN_CANDIDATE_PATTERN = /[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu;
const ENGLISH_WORD_PATTERN = /^[a-z]+(?:['-][a-z]+)*$/;
const ENGLISH_FRAGMENT_PATTERN = /[a-z]+(?:['-][a-z]+)*/g;
const ENGLISH_HANGUL_CANDIDATE_PATTERN = /^[a-z\p{Script=Hangul}'-]+$/u;
const OCR_REVIEW_CANDIDATE_PATTERN = /[a-z0-9]+(?:['-][a-z0-9]+)*/g;

const DEFAULT_ALLOWED_SHORT_WORDS = ['a', 'i'];

export interface WordFilterOptions {
  /** Minimum number of ASCII letters. Valid allow-listed words can be shorter. */
  minLetters?: number;
  /** Longest recognized English word is 45 letters, so 45 is a safe default. */
  maxLetters?: number;
  allowedShortWords?: Iterable<string>;
}

export interface WordExtractionOptions extends WordFilterOptions {
  existingWords?: Iterable<string>;
}

export interface OcrReviewCandidateOptions extends WordFilterOptions {
  /** Digit-heavy codes are ignored, while common OCR confusions such as w0rd remain visible. */
  maxDigits?: number;
}

export interface WordPartition {
  newWords: string[];
  existingWords: string[];
}

export interface WordExtractionResult extends WordPartition {
  /** All unique, plausible words in first-seen order. */
  words: string[];
  /** Words that occurred more than once in the OCR text (one entry per word). */
  duplicateWords: string[];
  /** Token-like chunks rejected as numbers, non-English text, or likely OCR noise. */
  rejected: string[];
}

/** Normalizes compatibility characters, quotes, dashes, and English casing. */
export function normalizeEnglishText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(TYPOGRAPHIC_APOSTROPHES, "'")
    .replace(TYPOGRAPHIC_DASHES, '-')
    .toLocaleLowerCase('en-US');
}

/**
 * Normalizes one user/OCR word. Returns an empty string when the value contains
 * zero or multiple word candidates, which prevents accidental phrase matches.
 */
export function normalizeEnglishWord(value: string): string {
  const matches = normalizeEnglishText(value).match(TOKEN_CANDIDATE_PATTERN) ?? [];
  if (matches.length !== 1) {
    return '';
  }

  return matches[0];
}

/**
 * Recovers English-looking OCR tokens for the confirmation screen without
 * treating them as valid words. This deliberately keeps a small amount of
 * likely noise (for example `w0rd` or a long vowel-free token) so the learner
 * can fix or remove it instead of losing it before review.
 */
export function extractEnglishOcrCandidates(
  values: Iterable<string>,
  options: OcrReviewCandidateOptions = {},
): string[] {
  const minLetters = Math.max(1, Math.floor(options.minLetters ?? 2));
  const maxLetters = Math.max(minLetters, Math.floor(options.maxLetters ?? 45));
  const maxDigits = Math.max(0, Math.floor(options.maxDigits ?? 2));
  const allowedShortWords = normalizedAllowedShortWords(options);
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const value of values) {
    const matches = normalizeEnglishText(value).match(OCR_REVIEW_CANDIDATE_PATTERN) ?? [];
    for (const candidate of matches) {
      const letterCount = candidate.match(/[a-z]/g)?.length ?? 0;
      const digitCount = candidate.match(/[0-9]/g)?.length ?? 0;
      const separatorCount = candidate.match(/['-]/g)?.length ?? 0;

      if (
        (letterCount < minLetters && !allowedShortWords.has(candidate))
        || letterCount > maxLetters
        || digitCount > maxDigits
        || separatorCount > 3
        || seen.has(candidate)
      ) {
        continue;
      }

      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function normalizedAllowedShortWords(options: WordFilterOptions): Set<string> {
  const values = options.allowedShortWords ?? DEFAULT_ALLOWED_SHORT_WORDS;
  const allowed = new Set<string>();

  for (const value of values) {
    const normalized = normalizeEnglishWord(value);
    if (normalized) {
      allowed.add(normalized);
    }
  }

  return allowed;
}

/** Lightweight heuristics only; no dictionary or network lookup is performed. */
export function isPlausibleEnglishWord(
  value: string,
  options: WordFilterOptions = {},
): boolean {
  const word = normalizeEnglishWord(value);
  if (!word || !ENGLISH_WORD_PATTERN.test(word)) {
    return false;
  }

  const letters = word.replace(/['-]/g, '');
  const minLetters = Math.max(1, Math.floor(options.minLetters ?? 2));
  const maxLetters = Math.max(minLetters, Math.floor(options.maxLetters ?? 45));
  const allowedShortWords = normalizedAllowedShortWords(options);

  if (letters.length < minLetters && !allowedShortWords.has(word)) {
    return false;
  }

  if (letters.length > maxLetters) {
    return false;
  }

  // Runs such as "llll" and long vowel-free fragments are common OCR artifacts.
  if (/^([a-z])\1{2,}$/.test(letters) || /([a-z])\1{3,}/.test(letters)) {
    return false;
  }

  if (letters.length >= 7 && !/[aeiouy]/.test(letters)) {
    return false;
  }

  const separatorCount = word.length - letters.length;
  if (separatorCount > 3) {
    return false;
  }

  const segments = word.split(/['-]/);
  if (segments.length >= 3 && segments.every((segment) => segment.length === 1)) {
    return false;
  }

  return true;
}

function normalizedWordSet(words: Iterable<string>): Set<string> {
  const normalized = new Set<string>();

  for (const word of words) {
    const candidate = normalizeEnglishWord(word);
    if (candidate) {
      normalized.add(candidate);
    }
  }

  return normalized;
}

/** Separates normalized words from entries already present in the wordbook. */
export function partitionExtractedWords(
  words: Iterable<string>,
  existingWords: Iterable<string>,
): WordPartition {
  const existingSet = normalizedWordSet(existingWords);
  const seen = new Set<string>();
  const partition: WordPartition = { newWords: [], existingWords: [] };

  for (const rawWord of words) {
    const word = normalizeEnglishWord(rawWord);
    if (!word || seen.has(word)) {
      continue;
    }

    seen.add(word);
    if (existingSet.has(word)) {
      partition.existingWords.push(word);
    } else {
      partition.newWords.push(word);
    }
  }

  return partition;
}

/**
 * Extracts ASCII English words while preserving internal apostrophes/hyphens.
 * Mixed letter/number chunks (for example, "w0rd") and non-ASCII chunks are
 * rejected rather than partially accepted as misleading words.
 */
export function extractEnglishWords(
  text: string,
  options: WordExtractionOptions = {},
): WordExtractionResult {
  const normalizedText = normalizeEnglishText(text);
  const candidates = normalizedText.match(TOKEN_CANDIDATE_PATTERN) ?? [];
  const seen = new Set<string>();
  const duplicateSet = new Set<string>();
  const rejectedSet = new Set<string>();
  const words: string[] = [];

  for (const candidate of candidates) {
    // Korean particles are often joined to an English word in mixed OCR
    // (`apple을`, `well-known이라는`). Pull out only the intact ASCII fragment,
    // but never partially accept number-mixed or other-script noise.
    const wordCandidates = ENGLISH_WORD_PATTERN.test(candidate)
      ? [candidate]
      : ENGLISH_HANGUL_CANDIDATE_PATTERN.test(candidate)
        ? candidate.match(ENGLISH_FRAGMENT_PATTERN) ?? []
        : [];

    if (wordCandidates.length === 0) {
      rejectedSet.add(candidate);
      continue;
    }

    let acceptedFragment = false;
    for (const fragment of wordCandidates) {
      const word = normalizeEnglishWord(fragment);
      if (!word || !isPlausibleEnglishWord(word, options)) continue;
      acceptedFragment = true;

      if (seen.has(word)) {
        duplicateSet.add(word);
        continue;
      }

      seen.add(word);
      words.push(word);
    }

    if (!acceptedFragment) rejectedSet.add(candidate);
  }

  const partition = partitionExtractedWords(words, options.existingWords ?? []);

  return {
    words,
    newWords: partition.newWords,
    existingWords: partition.existingWords,
    duplicateWords: [...duplicateSet],
    rejected: [...rejectedSet],
  };
}
