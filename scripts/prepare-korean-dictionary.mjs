import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA_VERSION = 2
const SOURCE_URL =
  'https://kaikki.org/kowiktionary/raw-wiktextract-data.jsonl.gz'
const SOURCE_PAGE = 'https://kaikki.org/kowiktionary/rawdata.html'
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const targetRoot = join(projectRoot, 'public', 'dictionary', 'ko-en')
const manifestPath = join(targetRoot, 'manifest.json')
const letters = 'abcdefghijklmnopqrstuvwxyz'.split('')
const englishWordPattern = /^[a-z]+(?:['-][a-z]+)*$/
const koreanPattern = /[\uac00-\ud7a3]/u

const POS_LABELS = {
  noun: '명사',
  name: '고유명사',
  'proper-noun': '고유명사',
  verb: '동사',
  adj: '형용사',
  adv: '부사',
  pron: '대명사',
  det: '한정사',
  article: '관사',
  prep: '전치사',
  adp: '전치사',
  conj: '접속사',
  interj: '감탄사',
  num: '수사',
  numeral: '수사',
  auxiliary: '조동사',
  particle: '조사',
  phrase: '구',
  prefix: '접두사',
  suffix: '접미사',
  abbrev: '약어',
}

function normalizeWord(value) {
  if (typeof value !== 'string') return ''
  const normalized = value
    .trim()
    .replace(/[\u2018\u2019\u02bc]/gu, "'")
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .toLocaleLowerCase('en-US')
  return englishWordPattern.test(normalized) ? normalized : ''
}

function cleanMeaning(value) {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(/,?\s*VOA Learning English\s*\(public domain\)/giu, '')
    .replace(/\s+/gu, ' ')
    .trim()

  if (!cleaned || !koreanPattern.test(cleaned)) return ''
  return cleaned.length > 150 ? `${cleaned.slice(0, 147).trim()}…` : cleaned
}

function koreanPos(entry) {
  const key = typeof entry?.pos === 'string' ? entry.pos.toLowerCase() : ''
  return POS_LABELS[key] ?? ''
}

function meaningsFromSenses(senses) {
  if (!Array.isArray(senses)) return []
  const meanings = []
  for (const sense of senses) {
    if (!sense || typeof sense !== 'object' || !Array.isArray(sense.glosses)) {
      continue
    }
    for (const gloss of sense.glosses) {
      const meaning = cleanMeaning(gloss)
      if (meaning && !meanings.includes(meaning)) meanings.push(meaning)
      if (meanings.length >= 3) return meanings
    }
  }
  return meanings
}

function createCandidate() {
  return {
    meanings: [],
    parts: [],
  }
}

function addUnique(target, values, limit) {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value)
    if (target.length >= limit) break
  }
}

function addCandidate(index, word, { meanings, partOfSpeech }) {
  if (!word) return
  const candidate = index.get(word) ?? createCandidate()
  addUnique(candidate.meanings, meanings, 3)
  addUnique(candidate.parts, partOfSpeech ? [partOfSpeech] : [], 2)
  index.set(word, candidate)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function assetsAreReady() {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.schemaVersion !== SCHEMA_VERSION) return false
    await Promise.all(
      letters.map(async (letter) => {
        const path = join(targetRoot, `${letter}.json`)
        const [metadata, bytes] = await Promise.all([stat(path), readFile(path)])
        const expected = manifest.chunks?.[letter]
        if (
          !expected ||
          metadata.size !== expected.bytes ||
          sha256(bytes) !== expected.sha256
        ) {
          throw new Error(`Dictionary chunk integrity mismatch: ${letter}`)
        }
      }),
    )
    return true
  } catch {
    return false
  }
}

if (await assetsAreReady()) {
  process.stdout.write('오프라인 한글 뜻 사전이 이미 준비되어 있습니다.\n')
  process.exit(0)
}

process.stdout.write('오프라인 한글 뜻 사전을 준비하는 중입니다.\n')
const response = await fetch(SOURCE_URL)
if (!response.ok || !response.body) {
  throw new Error(`Dictionary download failed: ${response.status}`)
}

const compressed = Readable.fromWeb(response.body)
const lines = createInterface({
  input: compressed.pipe(createGunzip()),
  crlfDelay: Number.POSITIVE_INFINITY,
})
const candidates = new Map()
let parsedRows = 0

for await (const line of lines) {
  if (!line.trim()) continue
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    continue
  }
  parsedRows += 1

  if (entry.lang_code !== 'en') continue

  const word = normalizeWord(entry.word)
  const meanings = meaningsFromSenses(entry.senses)
  const partOfSpeech = koreanPos(entry)
  if (word && (meanings.length > 0 || partOfSpeech)) {
    // Only exact English headwords are indexed. Wiktextract's `forms` may also
    // contain loose related forms, so copying them can attach the wrong sense.
    addCandidate(candidates, word, { meanings, partOfSpeech })
  }
}

const chunks = Object.fromEntries(letters.map((letter) => [letter, {}]))
for (const word of [...candidates.keys()].sort()) {
  const candidate = candidates.get(word)
  const meanings = candidate.meanings
  const parts = candidate.parts
  if (meanings.length === 0 && parts.length === 0) continue

  const letter = word[0]
  if (!chunks[letter]) continue
  chunks[letter][word] = {
    m: meanings.slice(0, 3).join('; '),
    p: parts.slice(0, 2).join('·'),
  }
}

await mkdir(targetRoot, { recursive: true })
const chunkManifest = {}
for (const letter of letters) {
  const serialized = `${JSON.stringify(chunks[letter])}\n`
  await writeFile(join(targetRoot, `${letter}.json`), serialized)
  chunkManifest[letter] = {
    entries: Object.keys(chunks[letter]).length,
    bytes: Buffer.byteLength(serialized),
    sha256: sha256(serialized),
  }
}

const entryCount = Object.values(chunkManifest).reduce(
  (sum, chunk) => sum + chunk.entries,
  0,
)
const sourceSnapshotRetrievedAt = new Date().toISOString()
await writeFile(
  join(targetRoot, 'NOTICE.txt'),
  [
    'WordLens 오프라인 한글 뜻 사전',
    '',
    '이 데이터는 한국어 위키낱말사전을 Kaikki.org/Wiktextract로 추출한 자료에서',
    '영어 표제어와 한국어 뜻을 선별·정규화하고, 첫 글자별 JSON으로 재구성했습니다.',
    `원본: ${SOURCE_PAGE}`,
    `정적 스냅샷 생성 시각: ${sourceSnapshotRetrievedAt}`,
    '이 파생 데이터는 Creative Commons Attribution-ShareAlike 4.0을 선택해 배포합니다.',
    'CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/',
    '',
    '자동 뜻과 품사는 학습 보조용 제안이며 문맥에 따라 사용자가 수정해야 할 수 있습니다.',
  ].join('\n'),
)
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      source: SOURCE_URL,
      sourcePage: SOURCE_PAGE,
      license: 'CC-BY-SA-4.0',
      extractedFrom: 'Korean Wiktionary via Kaikki.org/Wiktextract',
      sourceSnapshotRetrievedAt,
      entryCount,
      parsedRows,
      chunks: chunkManifest,
    },
    null,
    2,
  )}\n`,
)

process.stdout.write(`오프라인 한글 뜻 사전 ${entryCount.toLocaleString()}개 준비 완료\n`)
