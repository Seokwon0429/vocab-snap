import type {
  AddManyResult,
  DeleteFolderResult,
  ImportMode,
  ImportResult,
  QuizResult,
  VocabularyFolder,
  VocabularyFolderInput,
  WordEntry,
  WordEntryInput,
} from '../types'
import { apiRequest, ApiClientError } from './auth'
import {
  DuplicateFolderError,
  DuplicateWordError,
  FolderNotFoundError,
} from './db'

interface VocabularyResponse {
  entries: WordEntry[]
  folders: VocabularyFolder[]
}

function translateError(error: unknown, context: { word?: string; folder?: string } = {}): never {
  if (error instanceof ApiClientError) {
    if (error.code === 'DUPLICATE_WORD') {
      throw new DuplicateWordError(context.word ?? '')
    }
    if (error.code === 'DUPLICATE_FOLDER') {
      throw new DuplicateFolderError(context.folder ?? '')
    }
    if (error.code === 'FOLDER_NOT_FOUND') {
      throw new FolderNotFoundError(context.folder ?? '')
    }
  }
  throw error
}

export async function getAll(): Promise<WordEntry[]> {
  const response = await apiRequest<VocabularyResponse>('/vocabulary')
  return response.entries
}

export async function getFolders(): Promise<VocabularyFolder[]> {
  const response = await apiRequest<VocabularyResponse>('/vocabulary')
  return response.folders
}

export async function createFolder(name: string): Promise<VocabularyFolder> {
  try {
    const response = await apiRequest<{ folder: VocabularyFolder }>('/folders', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    return response.folder
  } catch (error) {
    return translateError(error, { folder: name })
  }
}

export async function renameFolder(id: string, name: string): Promise<VocabularyFolder> {
  try {
    const response = await apiRequest<{ folder: VocabularyFolder }>(
      `/folders/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
    )
    return response.folder
  } catch (error) {
    return translateError(error, { folder: name })
  }
}

export async function deleteFolder(id: string): Promise<DeleteFolderResult> {
  try {
    return await apiRequest<DeleteFolderResult>(`/folders/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  } catch (error) {
    return translateError(error, { folder: id })
  }
}

export async function moveWordsToFolder(
  ids: readonly string[],
  folderId: string | null,
): Promise<number> {
  try {
    const response = await apiRequest<{ moved: number }>('/words/move', {
      method: 'POST',
      body: JSON.stringify({ ids, folderId }),
    })
    return response.moved
  } catch (error) {
    return translateError(error, { folder: folderId ?? '' })
  }
}

export async function addMany(inputs: readonly WordEntryInput[]): Promise<AddManyResult> {
  try {
    return await apiRequest<AddManyResult>('/words/batch', {
      method: 'POST',
      body: JSON.stringify({ entries: inputs }),
    })
  } catch (error) {
    return translateError(error, { word: inputs[0]?.word })
  }
}

export async function put(input: WordEntryInput): Promise<WordEntry> {
  try {
    const response = await apiRequest<{ entry: WordEntry }>('/words', {
      method: 'PUT',
      body: JSON.stringify({ entry: input }),
    })
    return response.entry
  } catch (error) {
    return translateError(error, { word: input.word, folder: input.folderId ?? '' })
  }
}

export async function deleteMany(ids: readonly string[]): Promise<number> {
  const response = await apiRequest<{ deleted: number }>('/words', {
    method: 'DELETE',
    body: JSON.stringify({ ids }),
  })
  return response.deleted
}

export async function importEntries(
  entries: readonly WordEntryInput[],
  mode: ImportMode,
  folders: readonly VocabularyFolderInput[] = [],
): Promise<ImportResult> {
  try {
    return await apiRequest<ImportResult>('/vocabulary/import', {
      method: 'POST',
      body: JSON.stringify({ entries, mode, folders }),
    })
  } catch (error) {
    return translateError(error)
  }
}

export async function recordQuizResult(
  id: string,
  result: QuizResult,
): Promise<WordEntry> {
  const response = await apiRequest<{ entry: WordEntry }>(
    `/words/${encodeURIComponent(id)}/quiz`,
    { method: 'POST', body: JSON.stringify({ result }) },
  )
  return response.entry
}
