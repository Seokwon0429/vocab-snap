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

export interface RecognizeEnglishTextOptions {
  maxFileSizeBytes?: number;
  preprocess?: Omit<PreprocessImageOptions, 'signal' | 'onProgress'>;
  signal?: AbortSignal;
  onProgress?: (progress: OcrProgress) => void;
}

export interface OcrResult {
  text: string;
  confidence: number;
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

function calculateTargetSize(
  sourceWidth: number,
  sourceHeight: number,
  options: PreprocessImageOptions,
): { width: number; height: number } {
  const maxDimension = Math.max(320, options.maxDimension ?? 2400);
  const minDimension = clamp(options.minDimension ?? 1400, 0, maxDimension);
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

function mapWorkerProgress(message: LoggerMessage): Omit<OcrProgress, 'percent'> {
  const rawProgress = clamp(message.progress ?? 0, 0, 1);
  const status = message.status.toLocaleLowerCase('en-US');

  if (status.includes('recognizing')) {
    return {
      progress: 0.5 + rawProgress * 0.49,
      stage: 'recognizing',
      message: '사진에서 영어를 읽고 있어요.',
      rawStatus: message.status,
    };
  }

  if (status.includes('language')) {
    return {
      progress: 0.24 + rawProgress * 0.18,
      stage: 'loading',
      message: '영어 인식 데이터를 준비하고 있어요.',
      rawStatus: message.status,
    };
  }

  if (status.includes('initializing api')) {
    return {
      progress: 0.42 + rawProgress * 0.08,
      stage: 'loading',
      message: '인식 엔진을 시작하고 있어요.',
      rawStatus: message.status,
    };
  }

  return {
    progress: 0.12 + rawProgress * 0.12,
    stage: 'loading',
    message: '인식 엔진을 불러오고 있어요.',
    rawStatus: message.status,
  };
}

/**
 * Runs English OCR in a Tesseract.js Web Worker. The supplied image is passed
 * directly to that local worker; this module never uploads it or its OCR text.
 * A fresh worker is always terminated in `finally`, including after aborts.
 */
export async function recognizeEnglishText(
  file: File,
  options: RecognizeEnglishTextOptions = {},
): Promise<OcrResult> {
  assertValidImageFile(file, { maxSizeBytes: options.maxFileSizeBytes });
  throwIfAborted(options.signal);

  let worker: TesseractWorker | undefined;
  let terminationPromise: Promise<unknown> | undefined;
  let phase: 'preprocessing' | 'loading' | 'recognizing' = 'preprocessing';
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

    worker = await createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: ocrAssetUrl('worker.min.js'),
      corePath: ocrAssetUrl('core'),
      langPath: ocrAssetUrl('lang'),
      gzip: true,
      logger: (message) => emitProgress(mapWorkerProgress(message)),
    });

    throwIfAborted(options.signal);
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });

    throwIfAborted(options.signal);
    phase = 'recognizing';
    const result = await worker.recognize(preprocessed.blob, { rotateAuto: true });
    throwIfAborted(options.signal);

    const text = result.data.text.trim();
    if (!text) {
      throw new OcrError(
        'no_text_detected',
        '영어 문자를 찾지 못했습니다. 글자가 크고 선명하게 보이는 사진으로 다시 시도해 주세요.',
      );
    }

    emitProgress({
      progress: 1,
      stage: 'complete',
      message: '영어 인식이 끝났어요.',
    });

    return {
      text,
      confidence: result.data.confidence,
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
        '영어 인식 엔진을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
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
      '사진 인식 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      error,
    );
  } finally {
    options.signal?.removeEventListener('abort', handleAbort);
    await terminateWorker();
  }
}
