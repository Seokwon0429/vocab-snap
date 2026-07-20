import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const publicRoot = join(projectRoot, 'public', 'ocr')
const coreTarget = join(publicRoot, 'core')
const langTarget = join(publicRoot, 'lang')

const tesseractPackage = require.resolve('tesseract.js/package.json')
const tesseractRoot = dirname(tesseractPackage)
const corePackage = require.resolve('tesseract.js-core/package.json', {
  paths: [tesseractRoot],
})
const coreRoot = dirname(corePackage)

await mkdir(coreTarget, { recursive: true })
await mkdir(langTarget, { recursive: true })

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

const languageFile = join(langTarget, 'eng.traineddata.gz')
const languageUrl = 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz'

let languageReady = false
try {
  const existing = await readFile(languageFile)
  languageReady = existing.byteLength > 1_000_000
} catch {
  languageReady = false
}

if (!languageReady) {
  process.stdout.write('영어 OCR 모델을 준비하는 중입니다…\n')
  const response = await fetch(languageUrl)
  if (!response.ok) {
    throw new Error(`OCR language download failed: ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength < 1_000_000) {
    throw new Error('Downloaded OCR language data is unexpectedly small.')
  }
  await writeFile(languageFile, bytes)
}

const languageBytes = await readFile(languageFile)
const checksum = createHash('sha256').update(languageBytes).digest('hex')
await writeFile(
  join(publicRoot, 'asset-manifest.json'),
  `${JSON.stringify({
    tesseractVersion: require(tesseractPackage).version,
    language: 'eng',
    languageSha256: checksum,
  }, null, 2)}\n`,
)

process.stdout.write('브라우저 전용 OCR 자산 준비 완료\n')
