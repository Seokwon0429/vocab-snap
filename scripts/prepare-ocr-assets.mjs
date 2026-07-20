import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import englishDictionary from 'dictionary-en'

const require = createRequire(import.meta.url)
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const publicRoot = join(projectRoot, 'public', 'ocr')
const coreTarget = join(publicRoot, 'core')
const langTarget = join(publicRoot, 'lang')
const dictionaryTarget = join(publicRoot, 'dictionary')
const OCR_LANGUAGES = ['eng', 'kor']

const tesseractPackage = require.resolve('tesseract.js/package.json')
const tesseractRoot = dirname(tesseractPackage)
const corePackage = require.resolve('tesseract.js-core/package.json', {
  paths: [tesseractRoot],
})
const coreRoot = dirname(corePackage)

await mkdir(coreTarget, { recursive: true })
await mkdir(langTarget, { recursive: true })
await mkdir(dictionaryTarget, { recursive: true })

await copyFile(
  join(tesseractRoot, 'dist', 'worker.min.js'),
  join(publicRoot, 'worker.min.js'),
)

const coreFiles = [
  'tesseract-core.wasm.js',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
]

await Promise.all(
  coreFiles.map((file) => copyFile(join(coreRoot, file), join(coreTarget, file))),
)

const dictionaryEntry = fileURLToPath(import.meta.resolve('dictionary-en'))
const dictionaryRoot = dirname(dictionaryEntry)
const nspellRoot = dirname(require.resolve('nspell/package.json'))
const dictionaryAff = new Uint8Array(englishDictionary.aff)
const dictionaryDic = new Uint8Array(englishDictionary.dic)

await Promise.all([
  writeFile(join(dictionaryTarget, 'en.aff'), dictionaryAff),
  writeFile(join(dictionaryTarget, 'en.dic'), dictionaryDic),
  copyFile(
    join(dictionaryRoot, 'license'),
    join(dictionaryTarget, 'LICENSE.dictionary-en.txt'),
  ),
  copyFile(
    join(nspellRoot, 'license'),
    join(dictionaryTarget, 'LICENSE.nspell.txt'),
  ),
])

function looksLikeLanguageData(bytes) {
  return bytes.byteLength > 1_000_000 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

const languageAssets = {}

for (const language of OCR_LANGUAGES) {
  const languageFile = join(langTarget, `${language}.traineddata.gz`)
  const languageUrl = `https://tessdata.projectnaptha.com/4.0.0/${language}.traineddata.gz`
  let languageBytes

  try {
    const existing = await readFile(languageFile)
    if (looksLikeLanguageData(existing)) languageBytes = existing
  } catch {
    languageBytes = undefined
  }

  if (!languageBytes) {
    process.stdout.write(`${language} OCR 모델을 준비하는 중입니다.\n`)
    const response = await fetch(languageUrl)
    if (!response.ok) {
      throw new Error(`OCR language download failed (${language}): ${response.status}`)
    }

    const downloaded = new Uint8Array(await response.arrayBuffer())
    if (!looksLikeLanguageData(downloaded)) {
      throw new Error(`Downloaded OCR language data is invalid (${language}).`)
    }

    await writeFile(languageFile, downloaded)
    languageBytes = downloaded
  }

  languageAssets[language] = {
    bytes: languageBytes.byteLength,
    sha256: createHash('sha256').update(languageBytes).digest('hex'),
  }
}

await writeFile(
  join(publicRoot, 'asset-manifest.json'),
  `${JSON.stringify({
    tesseractVersion: require(tesseractPackage).version,
    languages: languageAssets,
    correctionDictionary: {
      affSha256: createHash('sha256').update(dictionaryAff).digest('hex'),
      dicSha256: createHash('sha256').update(dictionaryDic).digest('hex'),
    },
  }, null, 2)}\n`,
)

process.stdout.write('브라우저 전용 한·영 OCR 자산 준비 완료\n')
