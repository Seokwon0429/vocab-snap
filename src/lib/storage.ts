import type {
  ImportMode,
  QuizResult,
  VocabularyFolderInput,
  WordEntryInput,
} from '../types'
import { getAuthSession } from './auth'
import * as local from './db'
import * as remote from './serverStorage'

export {
  DuplicateFolderError,
  DuplicateWordError,
  FolderNotFoundError,
  StorageUnavailableError,
} from './db'

function activeStorage() {
  return getAuthSession() ? remote : local
}

export function getAll() {
  return activeStorage().getAll()
}

export function getFolders() {
  return activeStorage().getFolders()
}

export function createFolder(name: string) {
  return activeStorage().createFolder(name)
}

export function renameFolder(id: string, name: string) {
  return activeStorage().renameFolder(id, name)
}

export function deleteFolder(id: string) {
  return activeStorage().deleteFolder(id)
}

export function moveWordsToFolder(ids: readonly string[], folderId: string | null) {
  return activeStorage().moveWordsToFolder(ids, folderId)
}

export function addMany(entries: readonly WordEntryInput[]) {
  return activeStorage().addMany(entries)
}

export function put(entry: WordEntryInput) {
  return activeStorage().put(entry)
}

export function deleteMany(ids: readonly string[]) {
  return activeStorage().deleteMany(ids)
}

export function importEntries(
  entries: readonly WordEntryInput[],
  mode: ImportMode,
  folders: readonly VocabularyFolderInput[] = [],
) {
  return activeStorage().importEntries(entries, mode, folders)
}

export function recordQuizResult(id: string, result: QuizResult) {
  return activeStorage().recordQuizResult(id, result)
}

export async function getLocalVocabulary() {
  const [entries, folders] = await Promise.all([local.getAll(), local.getFolders()])
  return { entries, folders }
}

export async function importLocalVocabularyToServer() {
  const { entries, folders } = await getLocalVocabulary()
  return remote.importEntries(entries, 'merge', folders)
}
