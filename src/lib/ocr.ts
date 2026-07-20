import {
  createWorker,
  OEM,
  PSM,
  type LoggerMessage,
  type Worker as TesseractWorker,
} from 'tesseract.js';

export const DEFAULT_MAX_IMAGE_SIZE_BYTES = 15 * 1024 * 1024;

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/x-ms-bmp',
  'image/gif',
] as const;

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  'bmp',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'webp',
]);

const SUPPORTED_MIME_TYPE_SET = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);

export type OcrErrorCode =
  | 'cancelled'
  | 'decode_failed'
  | 'empty_file'
  | 'engine_load_failed'
  | 'file_too_large'
  | 'no_text_detected'
  | 'preprocessing_failed'
  | 'recognition_failed'
  | 'unsupported_browser'
  | 'unsupported_file';

export class OcrError extends Error {
  readonly code: OcrErrorCode;
  readonly cause?: unknown;

  constructor(code: OcrErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = code === 'cancelled' ? 'AbortError' : 'OcrError';
    this.code = code;
    this.cause = cause;
  }
}

export type ImageValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: 'empty_file' | 'file_too_large' | 'unsupported_file';
      message: string;
    };

export interface ImageValidationOptions {
  maxSizeBytes?: number;
}

export interface PreprocessImageOptions {
  /** Longest edge after resizing. */
  maxDimension?: number;
  /** Small images are enlarged up to this longest-edge target (at most 2x). */
  minDimension?: number;
  /** Hard guard against allocating an excessively large canvas. */
  maxPixels?: number;
  /** Contrast amount accepted by the standard -255..255 contrast formula. */
  contrast?: number;
  autoContrast?: boolean;
  grayscale?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export interface PreprocessedImage {
  blob: Blob;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

export type OcrProgressStage =
  | 'preprocessing'
  | 'loading'
  | 'recognizing'
  | 'selecting'
  | 'complete';

export interface OcrProgress {
  /** Normalized, monotonic progress in the inclusive 0..1 range. */
  progress: number;
  percent: number;
  stage: OcrProgressStage;
  message: string;
  /** Original Tesseract.js logger status, when the event came from the worker. */
  rawStatus?: string;
}

export type OcrAccuracyMode = 'standard' | 'accurate';
export type OcrVariant = 'balanced' | 'high-contrast';

export interface RecognizeImageTextOptions {
  maxFileSizeBytes?: number;
  preprocess?: Omit<PreprocessImageOptions, 'signal' | 'onProgress'>;
  /** Accurate mode compares two locally preprocessed versions of the image. */
  accuracyMode?: OcrAccuracyMode;
  signal?: AbortSignal;
  onProgress?: (progress: OcrProgress) => void;
}

/** @deprecated Use RecognizeImageTextOptions. */
export type RecognizeEnglishTextOptions = RecognizeImageTextOptions;

export interface OcrBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWordEvidence {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
  alternatives: string[];
  /** True when this word box appeared only in a non-selected accurate-mode pass. */
  recoveredFromAlternatePass?: boolean;
}

export interface OcrPassSummary {
  variant: OcrVariant;
  confidence: number;
  weightedWordConfidence: number;
  score: number;
  wordCount: number;
  characterCount: number;
}

export interface OcrResult {
  text: string;
  /** Selected text first, followed by other successful pass texts for review-only recovery. */
  candidateTexts?: readonly string[];
  confidence: number;
  words: OcrWordEvidence[];
  selectedVariant: OcrVariant;
  passes: OcrPassSummary[];
  detectedKorean: boolean;
  languages: readonly ['eng', 'kor'];
  sourceWidth: number;
  sourceHeight: number;
  processedWidth: number;
  processedHeight: number;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function safeProgressCallback(
  callback: ((progress: number) => void) | undefined,
  progress: number,
): void {
  try {
    callback?.(clamp(progress, 0, 1));
  } catch {
    // Consumer rendering errors must not leave a large OCR worker alive.
  }
}

function cancelledError(): OcrError {
  return new OcrError('cancelled', '사진 인식이 취소되었습니다.');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw cancelledError();
  }
}

function abortable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(cancelledError());

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      reject(cancelledError());
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      },
    );
  });
}

function fileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot >= 0 ? fileName.slice(lastDot + 1).toLocaleLowerCase('en-US') : '';
}

/**
 * Performs cheap validation before decoding. A renamed/corrupt file is still
 * rejected later by the browser image decoder.
 */
export function validateImageFile(
  file: File,
  options: ImageValidationOptions = {},
): ImageValidationResult {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_IMAGE_SIZE_BYTES;

  if (!file || file.size <= 0) {
    return {
      ok: false,
      code: 'empty_file',
      message: '비어 있는 이미지 파일입니다. 다른 사진을 선택해 주세요.',
    };
  }

  if (file.size > maxSizeBytes) {
    const maxMegabytes = Math.round((maxSizeBytes / (1024 * 1024)) * 10) / 10;
    return {
      ok: false,
      code: 'file_too_large',
      message: `이미지가 너무 큽니다. ${maxMegabytes}MB 이하 파일을 선택해 주세요.`,
    };
  }

  const mimeType = file.type.trim().toLocaleLowerCase('en-US');
  const extensionIsSupported = SUPPORTED_IMAGE_EXTENSIONS.has(fileExtension(file.name));
  const genericMimeType = mimeType === '' || mimeType === 'application/octet-stream';

  if (!SUPPORTED_MIME_TYPE_SET.has(mimeType) && !(genericMimeType && extensionIsSupported)) {
    return {
      ok: false,
      code: 'unsupported_file',
      message: '지원하지 않는 파일입니다. JPG, PNG, WebP, BMP 또는 GIF 이미지를 사용해 주세요.',
    };
  }

  return { ok: true };
}

export function assertValidImageFile(
  file: File,
  options: ImageValidationOptions = {},
): void {
  const result = validateImageFile(file, options);

  if (!result.ok) {
    throw new OcrError(result.code, result.message);
  }
}

function loadHtmlImage(blob: Blob, signal?: AbortSignal): Promise<DecodedImage> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);

    const cleanUp = () => {
      signal?.removeEventListener('abort', handleAbort);
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(objectUrl);
    };

    const handleAbort = () => {
      cleanUp();
      image.src = '';
      reject(cancelledError());
    };

    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      cleanUp();

      if (width <= 0 || height <= 0) {
        reject(new OcrError('decode_failed', '이미지 크기를 확인할 수 없습니다.'));
        return;
      }

      resolve({ source: image, width, height, close: () => undefined });
    };

    image.onerror = () => {
      cleanUp();
      reject(new OcrError('decode_failed', '이미지를 열 수 없습니다. 손상되지 않은 파일인지 확인해 주세요.'));
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    image.decoding = 'async';
    image.src = objectUrl;
  });
}

async function decodeImage(blob: Blob, signal?: AbortSignal): Promise<DecodedImage> {
  throwIfAborted(signal);

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      throwIfAborted(signal);

      if (bitmap.width <= 0 || bitmap.height <= 0) {
        bitmap.close();
        throw new OcrError('decode_failed', '이미지 크기를 확인할 수 없습니다.');
      }

      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch (error) {
      if (signal?.aborted || error instanceof OcrError) {
        throw error;
      }
      // Some browsers expose createImageBitmap but cannot decode every format.
      // The HTMLImageElement path has broader codec support, so try it next.
    }
  }

  return loadHtmlImage(blob, signal);
}

export function calculateTargetSize(
  sourceWidth: number,
  sourceHeight: number,
  options: PreprocessImageOptions,
): { width: number; height: number } {
  const maxDimension = Math.max(320, options.maxDimension ?? 4096);
  const minDimension = clamp(options.minDimension ?? 1600, 0, maxDimension);
  const maxPixels = Math.max(1_000_000, options.maxPixels ?? 6_000_000);
  const longestEdge = Math.max(sourceWidth, sourceHeight);

  let scale = Math.min(1, maxDimension / longestEdge);
  if (longestEdge < minDimension) {
    scale = Math.min(2, minDimension / longestEdge);
  }

  const scaledPixels = sourceWidth * sourceHeight * scale * scale;
  if (scaledPixels > maxPixels) {
    scale *= Math.sqrt(maxPixels / scaledPixels);
  }

  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function percentileFromHistogram(
  histogram: Uint32Array,
  pixelCount: number,
  percentile: number,
): number {
  const threshold = Math.max(1, Math.round(pixelCount * percentile));
  let count = 0;

  for (let value = 0; value < histogram.length; value += 1) {
    count += histogram[value];
    if (count >= threshold) {
      return value;
    }
  }

  return 255;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Decodes and improves an image entirely in the current browser. This function
 * performs no fetch/upload and returns a local Blob suitable for Tesseract.js.
 */
export async function preprocessImage(
  image: Blob,
  options: PreprocessImageOptions = {},
): Promise<PreprocessedImage> {
  if (typeof document === 'undefined') {
    throw new OcrError('unsupported_browser', '이미지 전처리는 브라우저에서만 사용할 수 있습니다.');
  }

  const { signal, onProgress } = options;
  throwIfAborted(signal);
  safeProgressCallback(onProgress, 0);

  let decoded: DecodedImage | undefined;

  try {
    decoded = await decodeImage(image, signal);
    throwIfAborted(signal);
    safeProgressCallback(onProgress, 0.1);

    const target = calculateTargetSize(decoded.width, decoded.height, options);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new OcrError('unsupported_browser', '이 브라우저에서는 이미지 처리를 시작할 수 없습니다.');
    }

    // A white background avoids turning transparent PNG areas black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, target.width, target.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.source, 0, 0, target.width, target.height);
    safeProgressCallback(onProgress, 0.2);

    const imageData = context.getImageData(0, 0, target.width, target.height);
    const { data } = imageData;
    const histogram = new Uint32Array(256);
    const rowStride = target.width * 4;

    for (let y = 0; y < target.height; y += 1) {
      const rowStart = y * rowStride;
      const rowEnd = rowStart + rowStride;

      for (let index = rowStart; index < rowEnd; index += 4) {
        const luminance = Math.round(
          data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114,
        );
        histogram[luminance] += 1;
      }

      if (y % 128 === 0) {
        throwIfAborted(signal);
        safeProgressCallback(onProgress, 0.2 + (y / target.height) * 0.25);
        await yieldToBrowser();
      }
    }

    const pixelCount = target.width * target.height;
    const autoContrast = options.autoContrast ?? true;
    const low = autoContrast ? percentileFromHistogram(histogram, pixelCount, 0.01) : 0;
    const high = autoContrast ? percentileFromHistogram(histogram, pixelCount, 0.99) : 255;
    const usefulRange = high - low >= 32;
    const contrast = clamp(options.contrast ?? 24, -254, 254);
    const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    const grayscale = options.grayscale ?? true;

    for (let y = 0; y < target.height; y += 1) {
      const rowStart = y * rowStride;
      const rowEnd = rowStart + rowStride;

      for (let index = rowStart; index < rowEnd; index += 4) {
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
        let value = luminance;

        if (autoContrast && usefulRange) {
          value = ((value - low) * 255) / (high - low);
        }

        value = clamp(contrastFactor * (value - 128) + 128, 0, 255);

        if (grayscale) {
          data[index] = value;
          data[index + 1] = value;
          data[index + 2] = value;
        } else {
          const originalLuminance = Math.max(1, luminance);
          const ratio = value / originalLuminance;
          data[index] = clamp(red * ratio, 0, 255);
          data[index + 1] = clamp(green * ratio, 0, 255);
          data[index + 2] = clamp(blue * ratio, 0, 255);
        }
      }

      if (y % 128 === 0) {
        throwIfAborted(signal);
        safeProgressCallback(onProgress, 0.45 + (y / target.height) * 0.4);
        await yieldToBrowser();
      }
    }

    throwIfAborted(signal);
    context.putImageData(imageData, 0, 0);
    safeProgressCallback(onProgress, 0.9);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new OcrError('preprocessing_failed', '처리된 이미지를 만들지 못했습니다.'));
        }
      }, 'image/png');
    });

    throwIfAborted(signal);
    safeProgressCallback(onProgress, 1);

    return {
      blob,
      width: target.width,
      height: target.height,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
    };
  } catch (error) {
    if (error instanceof OcrError) {
      throw error;
    }

    throw new OcrError(
      'preprocessing_failed',
      '이미지를 처리하지 못했습니다. 다른 사진으로 다시 시도해 주세요.',
      error,
    );
  } finally {
    decoded?.close();
  }
}

interface OcrWordLike {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
  choices?: Array<{ text: string; confidence: number }>;
}

interface OcrBlockLike {
  paragraphs: Array<{
    lines: Array<{
      words: OcrWordLike[];
    }>;
  }>;
}

interface OcrPassCandidate {
  variant: OcrVariant;
  text: string;
  confidence: number;
  words: OcrWordEvidence[];
  characterCount: number;
}

export interface OcrPassQualityInput {
  variant: OcrVariant;
  confidence: number;
  weightedWordConfidence: number;
  wordCount: number;
  characterCount: number;
}

/** Flattens only the lightweight word evidence needed by the review screen. */
export function flattenOcrWords(blocks: OcrBlockLike[] | null | undefined): OcrWordEvidence[] {
  if (!blocks) return [];

  const words: OcrWordEvidence[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = word.text?.trim();
          if (!text) continue;

          words.push({
            text,
            confidence: clamp(Number(word.confidence) || 0, 0, 100),
            bbox: word.bbox,
            alternatives: (word.choices ?? [])
              .filter((choice) => choice.text && choice.text !== text)
              .sort((left, right) => right.confidence - left.confidence)
              .slice(0, 3)
              .map((choice) => choice.text),
          });
        }
      }
    }
  }

  return words;
}

function boundingBoxIntersectionRatio(
  left: OcrBoundingBox,
  right: OcrBoundingBox,
): number {
  const intersectionWidth = Math.max(0, Math.min(left.x1, right.x1) - Math.max(left.x0, right.x0));
  const intersectionHeight = Math.max(0, Math.min(left.y1, right.y1) - Math.max(left.y0, right.y0));
  const intersection = intersectionWidth * intersectionHeight;
  if (intersection <= 0) return 0;

  const leftArea = Math.max(1, (left.x1 - left.x0) * (left.y1 - left.y0));
  const rightArea = Math.max(1, (right.x1 - right.x0) * (right.y1 - right.y0));
  return intersection / Math.min(leftArea, rightArea);
}

function boundingBoxArea(box: OcrBoundingBox): number {
  return Math.max(1, (box.x1 - box.x0) * (box.y1 - box.y0));
}

function comparableOcrText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201B\u02BC\u02BB\uFF07\u00B4`]/g, "'")
    .replace(/[\u00AD\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .trim()
    .toLocaleLowerCase('en-US');
}

/**
 * Keeps the selected pass as the source of truth while recovering word boxes
 * found only by another pass. Text recognized at the same location becomes a
 * correction alternative instead of a duplicate review row.
 */
export function consolidateOcrWordEvidence(
  selectedWords: readonly OcrWordEvidence[],
  alternateWords: readonly OcrWordEvidence[],
): OcrWordEvidence[] {
  const consolidated = selectedWords.map((word) => ({
    ...word,
    alternatives: [...word.alternatives],
    recoveredFromAlternatePass: false,
  }));
  const matchedSelectedIndices = new Set<number>();

  for (const alternate of alternateWords) {
    let matchingIndex = -1;
    let bestOverlap = 0;
    for (let index = 0; index < consolidated.length; index += 1) {
      if (matchedSelectedIndices.has(index)) continue;
      const overlap = boundingBoxIntersectionRatio(consolidated[index].bbox, alternate.bbox);
      const selectedArea = boundingBoxArea(consolidated[index].bbox);
      const alternateArea = boundingBoxArea(alternate.bbox);
      const areaRatio = Math.max(selectedArea, alternateArea) / Math.min(selectedArea, alternateArea);
      if (overlap >= 0.55 && areaRatio <= 1.6 && overlap > bestOverlap) {
        matchingIndex = index;
        bestOverlap = overlap;
      }
    }

    if (matchingIndex < 0) {
      consolidated.push({
        ...alternate,
        alternatives: [...alternate.alternatives],
        recoveredFromAlternatePass: true,
      });
      continue;
    }

    const matched = consolidated[matchingIndex];
    matchedSelectedIndices.add(matchingIndex);
    const matchedText = comparableOcrText(matched.text);
    const alternateText = comparableOcrText(alternate.text);
    if (matchedText === alternateText) {
      matched.confidence = Math.max(matched.confidence, alternate.confidence);
    }

    const alternatives = [alternate.text, ...alternate.alternatives, ...matched.alternatives];
    const seenAlternatives = new Set<string>();
    matched.alternatives = alternatives.filter((text) => {
      const comparable = comparableOcrText(text);
      if (!comparable || comparable === matchedText || seenAlternatives.has(comparable)) return false;
      seenAlternatives.add(comparable);
      return true;
    }).slice(0, 3);
  }

  return consolidated;
}

function weightedWordConfidence(words: readonly OcrWordEvidence[], pageConfidence: number): number {
  let weightedTotal = 0;
  let characterTotal = 0;

  for (const word of words) {
    const characters = word.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    weightedTotal += word.confidence * characters;
    characterTotal += characters;
  }

  return characterTotal ? weightedTotal / characterTotal : clamp(pageConfidence, 0, 100);
}

/** Scores passes without trusting a single very confident but incomplete word. */
export function scoreOcrPasses(
  inputs: readonly OcrPassQualityInput[],
): { selectedIndex: number; summaries: OcrPassSummary[] } {
  const maximumCharacters = Math.max(1, ...inputs.map((input) => input.characterCount));
  const summaries = inputs.map((input) => ({
    ...input,
    score: clamp(
      input.weightedWordConfidence * 0.55
        + input.confidence * 0.3
        + (input.characterCount / maximumCharacters) * 15,
      0,
      100,
    ),
  }));

  let selectedIndex = 0;
  for (let index = 1; index < summaries.length; index += 1) {
    if (summaries[index].score > summaries[selectedIndex].score + 0.01) {
      selectedIndex = index;
    }
  }

  return { selectedIndex, summaries };
}

function mapWorkerProgress(
  message: LoggerMessage,
  phase: 'loading' | 'recognizing',
  passIndex: number,
  passCount: number,
): Omit<OcrProgress, 'percent'> {
  const rawProgress = clamp(message.progress ?? 0, 0, 1);

  if (phase === 'recognizing') {
    const ranges = passCount === 1
      ? [[0.4, 0.98]]
      : [[0.4, 0.66], [0.74, 0.95]];
    const [start, end] = ranges[Math.min(passIndex, ranges.length - 1)];

    return {
      progress: start + rawProgress * (end - start),
      stage: 'recognizing',
      message: passCount === 1
        ? '사진에서 한국어와 영어를 읽고 있어요.'
        : `${passIndex + 1}번째 보정 이미지에서 한·영 문자를 읽고 있어요.`,
      rawStatus: message.status,
    };
  }

  return {
    progress: 0.1 + rawProgress * 0.3,
    stage: 'loading',
    message: '한국어·영어 인식 데이터를 준비하고 있어요.',
    rawStatus: message.status,
  };
}

/**
 * Runs Korean + English OCR in one local Tesseract.js Web Worker. In accurate
 * mode it compares two preprocessing strengths. No image or recognized text is
 * uploaded, and the worker is always terminated in `finally`.
 */
export async function recognizeImageText(
  file: File,
  options: RecognizeImageTextOptions = {},
): Promise<OcrResult> {
  assertValidImageFile(file, { maxSizeBytes: options.maxFileSizeBytes });
  throwIfAborted(options.signal);

  let worker: TesseractWorker | undefined;
  let terminationPromise: Promise<unknown> | undefined;
  let phase: 'preprocessing' | 'loading' | 'recognizing' | 'selecting' = 'preprocessing';
  const passCount = options.accuracyMode === 'standard' ? 1 : 2;
  let passIndex = 0;
  let latestProgress = 0;

  const emitProgress = (event: Omit<OcrProgress, 'percent'>) => {
    const progress = Math.max(latestProgress, clamp(event.progress, 0, 1));
    latestProgress = progress;

    try {
      options.onProgress?.({
        ...event,
        progress,
        percent: Math.round(progress * 100),
      });
    } catch {
      // A UI callback must not interrupt worker cleanup.
    }
  };

  const terminateWorker = (): Promise<unknown> => {
    if (!terminationPromise && worker) {
      terminationPromise = worker.terminate().catch(() => undefined);
    }
    return terminationPromise ?? Promise.resolve();
  };

  const handleAbort = () => {
    void terminateWorker();
  };

  options.signal?.addEventListener('abort', handleAbort, { once: true });

  try {
    emitProgress({
      progress: 0,
      stage: 'preprocessing',
      message: '사진을 선명하게 다듬고 있어요.',
    });

    const preprocessed = await preprocessImage(file, {
      ...options.preprocess,
      maxPixels: options.preprocess?.maxPixels ?? 6_000_000,
      contrast: options.preprocess?.contrast ?? 22,
      signal: options.signal,
      onProgress: (progress) => {
        emitProgress({
          progress: progress * 0.1,
          stage: 'preprocessing',
          message: '사진을 선명하게 다듬고 있어요.',
        });
      },
    });

    throwIfAborted(options.signal);
    phase = 'loading';
    emitProgress({
      progress: 0.1,
      stage: 'loading',
      message: '인식 엔진을 불러오고 있어요.',
    });

    const ocrAssetUrl = (relativePath: string) =>
      new URL(`ocr/${relativePath}`, document.baseURI).href;

    worker = await createWorker(['eng', 'kor'], OEM.LSTM_ONLY, {
      workerPath: ocrAssetUrl('worker.min.js'),
      corePath: ocrAssetUrl('core'),
      langPath: ocrAssetUrl('lang'),
      cachePath: 'vocab-snap-ocr-v2',
      gzip: true,
      logger: (message) => {
        if (phase === 'loading' || phase === 'recognizing') {
          emitProgress(mapWorkerProgress(message, phase, passIndex, passCount));
        }
      },
    });

    throwIfAborted(options.signal);
    await abortable(
      worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      }),
      options.signal,
    );

    const candidates: OcrPassCandidate[] = [];
    let firstRotation: number | null = null;
    let lastRecognitionError: unknown;

    const recognizeVariant = async (
      image: PreprocessedImage,
      variant: OcrVariant,
      currentPassIndex: number,
    ) => {
      passIndex = currentPassIndex;
      phase = 'recognizing';
      await abortable(
        worker!.setParameters({
          tessedit_pageseg_mode: currentPassIndex === 0 ? PSM.AUTO : PSM.SPARSE_TEXT,
        }),
        options.signal,
      );
      const recognizeOptions = currentPassIndex > 0 && firstRotation !== null
        ? { rotateRadians: firstRotation }
        : { rotateAuto: true };
      const result = await abortable(
        worker!.recognize(
          image.blob,
          recognizeOptions,
          { text: true, blocks: true },
        ),
        options.signal,
      );
      throwIfAborted(options.signal);

      if (currentPassIndex === 0) firstRotation = result.data.rotateRadians;
      const text = result.data.text.trim();
      const words = flattenOcrWords(result.data.blocks);
      const characterCount = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
      candidates.push({
        variant,
        text,
        confidence: clamp(result.data.confidence, 0, 100),
        words,
        characterCount,
      });
    };

    try {
      await recognizeVariant(preprocessed, 'balanced', 0);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastRecognitionError = error;
    }

    if (passCount === 2) {
      try {
        phase = 'preprocessing';
        emitProgress({
          progress: 0.66,
          stage: 'preprocessing',
          message: '더 강한 대비로 한 번 더 선명하게 만들고 있어요.',
        });
        const highContrast = await preprocessImage(file, {
          ...options.preprocess,
          maxPixels: options.preprocess?.maxPixels ?? 6_000_000,
          contrast: clamp((options.preprocess?.contrast ?? 22) + 32, -254, 254),
          signal: options.signal,
          onProgress: (progress) => {
            emitProgress({
              progress: 0.66 + progress * 0.08,
              stage: 'preprocessing',
              message: '더 강한 대비로 한 번 더 선명하게 만들고 있어요.',
            });
          },
        });
        await recognizeVariant(highContrast, 'high-contrast', 1);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        lastRecognitionError = error;
      }
    }

    throwIfAborted(options.signal);
    const usableCandidates = candidates.filter((candidate) => candidate.text.length > 0);
    if (usableCandidates.length === 0) {
      if (lastRecognitionError && candidates.length === 0) throw lastRecognitionError;
      throw new OcrError(
        'no_text_detected',
        '한국어 또는 영어 문자를 찾지 못했습니다. 글자가 크고 선명한 사진으로 다시 시도해 주세요.',
      );
    }

    phase = 'selecting';
    emitProgress({
      progress: 0.97,
      stage: 'selecting',
      message: '더 정확한 인식 결과를 고르고 있어요.',
    });
    const ranked = scoreOcrPasses(usableCandidates.map((candidate) => ({
      variant: candidate.variant,
      confidence: candidate.confidence,
      weightedWordConfidence: weightedWordConfidence(candidate.words, candidate.confidence),
      wordCount: candidate.words.length,
      characterCount: candidate.characterCount,
    })));
    const selected = usableCandidates[ranked.selectedIndex];
    const alternateWords = usableCandidates.flatMap((candidate, index) => (
      index === ranked.selectedIndex ? [] : candidate.words
    ));
    const consolidatedWords = consolidateOcrWordEvidence(selected.words, alternateWords);

    emitProgress({
      progress: 1,
      stage: 'complete',
      message: '한국어·영어 인식과 비교가 끝났어요.',
    });

    return {
      text: selected.text,
      candidateTexts: [
        selected.text,
        ...usableCandidates
          .filter((_, index) => index !== ranked.selectedIndex)
          .map((candidate) => candidate.text),
      ],
      confidence: selected.confidence,
      words: consolidatedWords,
      selectedVariant: selected.variant,
      passes: ranked.summaries,
      detectedKorean: usableCandidates.some((candidate) => /\p{Script=Hangul}/u.test(candidate.text)),
      languages: ['eng', 'kor'],
      sourceWidth: preprocessed.sourceWidth,
      sourceHeight: preprocessed.sourceHeight,
      processedWidth: preprocessed.width,
      processedHeight: preprocessed.height,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw cancelledError();
    }

    if (error instanceof OcrError) {
      throw error;
    }

    if (phase === 'loading') {
      throw new OcrError(
        'engine_load_failed',
        '한·영 인식 엔진을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
        error,
      );
    }

    if (phase === 'preprocessing') {
      throw new OcrError(
        'preprocessing_failed',
        '사진을 처리하지 못했습니다. 다른 이미지로 다시 시도해 주세요.',
        error,
      );
    }

    throw new OcrError(
      'recognition_failed',
      '한국어·영어 인식 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      error,
    );
  } finally {
    options.signal?.removeEventListener('abort', handleAbort);
    await terminateWorker();
  }
}

/** @deprecated Kept for compatibility with earlier callers. */
export const recognizeEnglishText = recognizeImageText;
