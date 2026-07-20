import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  ArrowDownAZ,
  BookOpen,
  Check,
  CheckSquare2,
  Download,
  Edit3,
  FileJson,
  FileSpreadsheet,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  MoveRight,
  Plus,
  Search,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import type { ImportMode, VocabularyFolder, WordEntry, WordEntryInput } from '../types'
import {
  createFolder,
  deleteFolder,
  deleteMany,
  DuplicateWordError,
  getFolders,
  importEntries,
  moveWordsToFolder,
  put,
  renameFolder,
} from '../lib/db'
import { downloadExport, parseImportFile } from '../lib/importExport'
import { enrichWithKoreanDefinitions } from '../lib/koreanDictionary'
import { calculateDictionaryColumnWidths } from '../lib/dictionaryLayout'
import type { ToastKind } from './Toast'

type SortKey = 'newest' | 'oldest' | 'word-asc' | 'word-desc'
type FolderFilter = 'all' | 'unfiled' | string

const UNFILED_DESTINATION = '__unfiled__'
const WORD_DRAG_TYPE = 'application/x-vocab-word-ids'

interface DictionaryViewProps {
  entries: WordEntry[]
  loading: boolean
  speechAvailable: boolean
  onSpeak: (word: string) => void
  onChanged: () => Promise<void>
  notify: (text: string, kind?: ToastKind) => void
}

interface WordFormState {
  word: string
  meaning: string
  partOfSpeech: string
  memo: string
  folderId: string
}

type DictionaryTableStyle = CSSProperties & {
  '--word-column-width': string
  '--memo-column-width': string
}

const emptyForm: WordFormState = {
  word: '',
  meaning: '',
  partOfSpeech: '',
  memo: '',
  folderId: '',
}

const wordPattern = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/

function matchesSearch(entry: WordEntry, query: string) {
  if (!query) return true
  const haystack = [entry.word, entry.meaning, entry.partOfSpeech, entry.memo]
    .join(' ')
    .toLocaleLowerCase()
  return haystack.includes(query.toLocaleLowerCase())
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ko-KR', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

export function DictionaryView({
  entries,
  loading,
  speechAvailable,
  onSpeak,
  onChanged,
  notify,
}: DictionaryViewProps) {
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('newest')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<WordEntry | null | 'new'>(null)
  const [form, setForm] = useState<WordFormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [backfilling, setBackfilling] = useState(false)
  const [importMode, setImportMode] = useState<ImportMode>('merge')
  const [importing, setImporting] = useState(false)
  const [folders, setFolders] = useState<VocabularyFolder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [activeFolderId, setActiveFolderId] = useState<FolderFilter>('all')
  const [showFolderForm, setShowFolderForm] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [folderAnnouncement, setFolderAnnouncement] = useState('')
  const importInputRef = useRef<HTMLInputElement>(null)
  const draggedIdsRef = useRef<string[]>([])

  const refreshFolders = useCallback(async () => {
    try {
      const storedFolders = await getFolders()
      setFolders(storedFolders)
    } catch {
      notify('폴더 목록을 불러오지 못했어요.', 'error')
    } finally {
      setFoldersLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void refreshFolders()
  }, [refreshFolders])

  useEffect(() => {
    if (
      activeFolderId !== 'all'
      && activeFolderId !== 'unfiled'
      && !folders.some((folder) => folder.id === activeFolderId)
    ) {
      setActiveFolderId('all')
    }
  }, [activeFolderId, folders])

  const validFolderIds = useMemo(
    () => new Set(folders.map((folder) => folder.id)),
    [folders],
  )

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const folder of folders) counts.set(folder.id, 0)
    for (const entry of entries) {
      if (entry.folderId && validFolderIds.has(entry.folderId)) {
        counts.set(entry.folderId, (counts.get(entry.folderId) ?? 0) + 1)
      }
    }
    return counts
  }, [entries, folders, validFolderIds])

  const unfiledCount = useMemo(
    () => entries.filter((entry) => !entry.folderId || !validFolderIds.has(entry.folderId)).length,
    [entries, validFolderIds],
  )

  const activeFolderLabel = useMemo(() => {
    if (activeFolderId === 'all') return '전체 단어'
    if (activeFolderId === 'unfiled') return '미분류'
    return folders.find((folder) => folder.id === activeFolderId)?.name ?? '전체 단어'
  }, [activeFolderId, folders])

  const folderNameForEntry = (entry: WordEntry) => {
    if (!entry.folderId || !validFolderIds.has(entry.folderId)) return '미분류'
    return folders.find((folder) => folder.id === entry.folderId)?.name ?? '미분류'
  }

  const filteredEntries = useMemo(() => {
    const collator = new Intl.Collator('en', { sensitivity: 'base' })
    const result = entries.filter((entry) => {
      const folderMatches = activeFolderId === 'all'
        || (activeFolderId === 'unfiled'
          ? !entry.folderId || !validFolderIds.has(entry.folderId)
          : entry.folderId === activeFolderId)
      return folderMatches && matchesSearch(entry, query.trim())
    })
    return [...result].sort((left, right) => {
      if (sortKey === 'word-asc') return collator.compare(left.word, right.word)
      if (sortKey === 'word-desc') return collator.compare(right.word, left.word)
      if (sortKey === 'oldest') return left.createdAt.localeCompare(right.createdAt)
      return right.createdAt.localeCompare(left.createdAt)
    })
  }, [activeFolderId, entries, query, sortKey, validFolderIds])

  const dictionaryTableStyle = useMemo<DictionaryTableStyle>(() => {
    const widths = calculateDictionaryColumnWidths(
      filteredEntries.map((entry) => entry.word),
    )
    return {
      '--word-column-width': `${widths.word}%`,
      '--memo-column-width': `${widths.memo}%`,
    }
  }, [filteredEntries])

  useEffect(() => {
    const validIds = new Set(entries.map((entry) => entry.id))
    setSelectedIds((current) => new Set([...current].filter((id) => validIds.has(id))))
  }, [entries])

  const visibleIds = filteredEntries.map((entry) => entry.id)
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
      else visibleIds.forEach((id) => next.add(id))
      return next
    })
  }

  const chooseFolder = (folderId: FolderFilter) => {
    setActiveFolderId(folderId)
    setSelectedIds(new Set())
  }

  const submitNewFolder = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = newFolderName.trim()
    if (!name) {
      notify('폴더 이름을 입력해 주세요.', 'error')
      return
    }

    setFolderBusy(true)
    try {
      const created = await createFolder(name)
      await refreshFolders()
      setActiveFolderId(created.id)
      setNewFolderName('')
      setShowFolderForm(false)
      setFolderAnnouncement(`${name} 폴더를 만들었어요.`)
      notify(`${name} 폴더를 만들었어요.`, 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : '폴더를 만들지 못했어요.', 'error')
    } finally {
      setFolderBusy(false)
    }
  }

  const beginRenameFolder = (folder: VocabularyFolder) => {
    setRenamingFolderId(folder.id)
    setRenameValue(folder.name)
  }

  const submitFolderRename = async (
    event: React.FormEvent<HTMLFormElement>,
    folder: VocabularyFolder,
  ) => {
    event.preventDefault()
    const name = renameValue.trim()
    if (!name) {
      notify('폴더 이름을 입력해 주세요.', 'error')
      return
    }

    setFolderBusy(true)
    try {
      await renameFolder(folder.id, name)
      await refreshFolders()
      setRenamingFolderId(null)
      setRenameValue('')
      setFolderAnnouncement(`${folder.name} 폴더 이름을 ${name}(으)로 바꿨어요.`)
      notify('폴더 이름을 바꿨어요.', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : '폴더 이름을 바꾸지 못했어요.', 'error')
    } finally {
      setFolderBusy(false)
    }
  }

  const removeFolder = async (folder: VocabularyFolder) => {
    const confirmed = window.confirm(
      `“${folder.name}” 폴더를 삭제할까요? 폴더 안의 단어는 미분류로 이동합니다.`,
    )
    if (!confirmed) return

    setFolderBusy(true)
    try {
      await deleteFolder(folder.id)
      if (activeFolderId === folder.id) setActiveFolderId('unfiled')
      await Promise.all([refreshFolders(), onChanged()])
      setFolderAnnouncement(`${folder.name} 폴더를 삭제하고 단어를 미분류로 옮겼어요.`)
      notify(`${folder.name} 폴더를 삭제했어요.`, 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : '폴더를 삭제하지 못했어요.', 'error')
    } finally {
      setFolderBusy(false)
    }
  }

  const moveWords = async (ids: string[], folderId: string | null) => {
    const uniqueIds = [...new Set(ids)].filter((id) => entries.some((entry) => entry.id === id))
    if (uniqueIds.length === 0) return

    const destinationName = folderId
      ? folders.find((folder) => folder.id === folderId)?.name ?? '선택한 폴더'
      : '미분류'
    setFolderBusy(true)
    try {
      await moveWordsToFolder(uniqueIds, folderId)
      await onChanged()
      setSelectedIds((current) => {
        const next = new Set(current)
        uniqueIds.forEach((id) => next.delete(id))
        return next
      })
      const message = `${uniqueIds.length}개 단어를 ${destinationName}(으)로 이동했어요.`
      setFolderAnnouncement(message)
      notify(message, 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : '단어를 이동하지 못했어요.', 'error')
    } finally {
      setFolderBusy(false)
      setDragOverFolderId(null)
      setDraggingIds([])
      draggedIdsRef.current = []
    }
  }

  const startWordDrag = (event: React.DragEvent<HTMLElement>, entryId: string) => {
    const ids = selectedIds.has(entryId) ? [...selectedIds] : [entryId]
    draggedIdsRef.current = ids
    setDraggingIds(ids)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(WORD_DRAG_TYPE, JSON.stringify(ids))
    event.dataTransfer.setData('text/plain', ids.join(','))
  }

  const finishWordDrag = () => {
    draggedIdsRef.current = []
    setDraggingIds([])
    setDragOverFolderId(null)
  }

  const idsFromDrop = (event: React.DragEvent<HTMLElement>) => {
    const serialized = event.dataTransfer.getData(WORD_DRAG_TYPE)
    if (serialized) {
      try {
        const parsed: unknown = JSON.parse(serialized)
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
          return parsed
        }
      } catch {
        // Fall back to the in-memory drag state for browsers that alter custom data.
      }
    }
    return draggedIdsRef.current
  }

  const dropWordsOnFolder = (
    event: React.DragEvent<HTMLElement>,
    folderId: string | null,
  ) => {
    event.preventDefault()
    void moveWords(idsFromDrop(event), folderId)
  }

  const handleBulkMove = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const destination = event.target.value
    if (!destination) return
    void moveWords(
      [...selectedIds],
      destination === UNFILED_DESTINATION ? null : destination,
    )
    event.target.value = ''
  }

  const openEditor = (entry?: WordEntry) => {
    setEditing(entry ?? 'new')
    setForm(
      entry
        ? {
            word: entry.word,
            meaning: entry.meaning,
            partOfSpeech: entry.partOfSpeech,
            memo: entry.memo,
            folderId: entry.folderId ?? '',
          }
        : {
            ...emptyForm,
            folderId:
              activeFolderId !== 'all' && activeFolderId !== 'unfiled'
                ? activeFolderId
                : '',
          },
    )
  }

  const closeEditor = () => {
    if (!saving) setEditing(null)
  }

  const saveWord = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const word = form.word.trim()
    if (!wordPattern.test(word)) {
      notify("영문과 단어 안쪽의 아포스트로피(')·하이픈(-)만 사용할 수 있어요.", 'error')
      return
    }
    setSaving(true)
    try {
      const input: WordEntryInput = {
        ...(editing && editing !== 'new' ? editing : {}),
        word,
        meaning: form.meaning.trim(),
        partOfSpeech: form.partOfSpeech.trim(),
        memo: form.memo.trim(),
        folderId: form.folderId || null,
      }
      const enriched = await enrichWithKoreanDefinitions([input])
      await put(enriched.entries[0])
      await onChanged()
      setEditing(null)
      notify(editing === 'new' ? '단어를 추가했어요.' : '단어를 수정했어요.', 'success')
    } catch (error) {
      notify(
        error instanceof DuplicateWordError
          ? '같은 단어가 이미 단어장에 있어요.'
          : '단어를 저장하지 못했어요. 다시 시도해 주세요.',
        'error',
      )
    } finally {
      setSaving(false)
    }
  }

  const fillMissingDefinitions = async () => {
    const candidates = entries.filter(
      (entry) => !entry.meaning.trim() || !entry.partOfSpeech.trim(),
    )
    if (candidates.length === 0) {
      notify('빈 뜻이나 품사가 있는 단어가 없어요.', 'info')
      return
    }

    setBackfilling(true)
    try {
      const enriched = await enrichWithKoreanDefinitions(candidates)
      const changedEntries = enriched.entries.filter((entry, index) => {
        const original = candidates[index]
        return (
          (entry.meaning ?? '') !== original.meaning
          || (entry.partOfSpeech ?? '') !== original.partOfSpeech
        )
      })

      await Promise.all(changedEntries.map((entry) => put(entry)))
      if (changedEntries.length > 0) await onChanged()

      const unmatchedCount = candidates.length - changedEntries.length
      if (changedEntries.length > 0) {
        const unmatchedMessage = unmatchedCount > 0
          ? ` 사전에 없는 ${unmatchedCount}개는 그대로 두었어요.`
          : ''
        notify(
          `${changedEntries.length}개 단어의 빈 뜻·품사를 채웠어요.${unmatchedMessage}`,
          enriched.unavailable ? 'info' : 'success',
        )
      } else {
        notify(
          enriched.unavailable
            ? '뜻 사전을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'
            : '사전에서 채울 수 있는 단어를 찾지 못했어요.',
          enriched.unavailable ? 'error' : 'info',
        )
      }
    } catch {
      notify('빈 뜻과 품사를 채우지 못했어요. 다시 시도해 주세요.', 'error')
    } finally {
      setBackfilling(false)
    }
  }

  const removeWords = async (ids: string[], label: string) => {
    if (ids.length === 0) return
    if (!window.confirm(`${label} 삭제할까요? 이 작업은 되돌릴 수 없어요.`)) return
    try {
      await deleteMany(ids)
      await onChanged()
      notify(`${ids.length}개 단어를 삭제했어요.`, 'success')
    } catch {
      notify('단어를 삭제하지 못했어요.', 'error')
    }
  }

  const handleImport = async (file: File | undefined) => {
    if (!file) return
    if (importMode === 'replace') {
      const confirmed = window.confirm(
        '현재 단어장을 모두 지우고 가져온 데이터로 바꿀까요? 이 작업은 되돌릴 수 없어요.',
      )
      if (!confirmed) {
        if (importInputRef.current) importInputRef.current.value = ''
        return
      }
    }
    setImporting(true)
    try {
      const parsed = await parseImportFile(file)
      if (parsed.entries.length === 0 && parsed.folders.length === 0) {
        const firstIssue = parsed.issues[0]?.message
        throw new Error(firstIssue || '가져올 수 있는 단어나 폴더가 없어요.')
      }
      const enriched = await enrichWithKoreanDefinitions(parsed.entries)
      const result = await importEntries(enriched.entries, importMode, parsed.folders)
      await Promise.all([onChanged(), refreshFolders()])
      const details = [
        `${result.added.length}개 가져옴`,
        result.foldersAdded.length ? `폴더 ${result.foldersAdded.length}개 추가` : '',
        result.foldersReused.length ? `폴더 ${result.foldersReused.length}개 재사용` : '',
        result.duplicates.length ? `${result.duplicates.length}개 중복 건너뜀` : '',
        parsed.rejectedCount ? `${parsed.rejectedCount}개 오류 제외` : '',
        parsed.rejectedFolderCount ? `폴더 ${parsed.rejectedFolderCount}개 오류 제외` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      notify(details, parsed.rejectedCount ? 'info' : 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : '파일을 가져오지 못했어요.', 'error')
    } finally {
      setImporting(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const empty = !loading && entries.length === 0
  const noSearchResult = !loading && entries.length > 0 && filteredEntries.length === 0

  return (
    <section className="page dictionary-page" aria-labelledby="dictionary-title">
      <div className="page-heading dictionary-heading">
        <div>
          <span className="eyebrow">MY VOCABULARY</span>
          <h1 id="dictionary-title">내 단어장</h1>
          <p>사진에서 모은 단어를 나만의 설명과 함께 완성해 보세요.</p>
        </div>
        <div className="dictionary-heading-actions">
          <button
            type="button"
            className="button button-quiet"
            onClick={() => void fillMissingDefinitions()}
            disabled={backfilling || loading || entries.length === 0}
          >
            <BookOpen size={18} aria-hidden="true" />
            {backfilling ? '자동 채우는 중…' : '빈 뜻·품사 채우기'}
          </button>
          <button type="button" className="button button-primary" onClick={() => openEditor()}>
            <Plus size={18} aria-hidden="true" /> 직접 추가
          </button>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">{folderAnnouncement}</p>

      <div className="dictionary-workspace">
        <aside className="folder-panel surface" aria-labelledby="folder-panel-title">
          <div className="folder-panel-header">
            <div>
              <span className="folder-panel-kicker">ORGANIZE</span>
              <h2 id="folder-panel-title"><FolderOpen size={18} aria-hidden="true" /> 폴더</h2>
            </div>
            <button
              type="button"
              className="folder-add-button"
              onClick={() => setShowFolderForm((current) => !current)}
              aria-expanded={showFolderForm}
              aria-controls="new-folder-form"
              aria-label="새 폴더 만들기"
              disabled={folderBusy}
            >
              <FolderPlus size={18} aria-hidden="true" />
            </button>
          </div>

          {showFolderForm ? (
            <form id="new-folder-form" className="folder-inline-form" onSubmit={(event) => void submitNewFolder(event)}>
              <label className="sr-only" htmlFor="new-folder-name">새 폴더 이름</label>
              <input
                id="new-folder-name"
                autoFocus
                maxLength={40}
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setShowFolderForm(false)
                    setNewFolderName('')
                  }
                }}
                placeholder="예: 시험 대비"
              />
              <button type="submit" className="folder-form-action" disabled={folderBusy || !newFolderName.trim()} aria-label="폴더 만들기">
                <Check size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="folder-form-action"
                onClick={() => { setShowFolderForm(false); setNewFolderName('') }}
                aria-label="폴더 만들기 취소"
                disabled={folderBusy}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </form>
          ) : null}

          <nav className="folder-navigation" aria-label="단어장 폴더">
            <ul className="folder-list">
              <li className="folder-list-item folder-list-item-system">
                <button
                  type="button"
                  className={`folder-filter-button ${activeFolderId === 'all' ? 'is-active' : ''}`}
                  onClick={() => chooseFolder('all')}
                  aria-current={activeFolderId === 'all' ? 'page' : undefined}
                  aria-label={`전체 단어, ${entries.length}개`}
                >
                  <BookOpen size={17} aria-hidden="true" />
                  <span className="folder-name">전체 단어</span>
                  <span className="folder-count" aria-hidden="true">{entries.length}</span>
                </button>
              </li>
              <li
                className={`folder-list-item folder-list-item-system ${dragOverFolderId === UNFILED_DESTINATION ? 'is-drag-over' : ''}`}
                onDragEnter={(event) => { event.preventDefault(); setDragOverFolderId(UNFILED_DESTINATION) }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverFolderId(null)
                }}
                onDrop={(event) => dropWordsOnFolder(event, null)}
              >
                <button
                  type="button"
                  className={`folder-filter-button ${activeFolderId === 'unfiled' ? 'is-active' : ''}`}
                  onClick={() => chooseFolder('unfiled')}
                  aria-current={activeFolderId === 'unfiled' ? 'page' : undefined}
                  aria-label={`미분류, ${unfiledCount}개. 단어를 이곳에 끌어 놓아 이동할 수 있습니다.`}
                >
                  <Folder size={17} aria-hidden="true" />
                  <span className="folder-name">미분류</span>
                  <span className="folder-count" aria-hidden="true">{unfiledCount}</span>
                </button>
              </li>

              {folders.map((folder) => (
                <li
                  key={folder.id}
                  className={`folder-list-item ${dragOverFolderId === folder.id ? 'is-drag-over' : ''}`}
                  onDragEnter={(event) => { event.preventDefault(); setDragOverFolderId(folder.id) }}
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverFolderId(null)
                  }}
                  onDrop={(event) => dropWordsOnFolder(event, folder.id)}
                >
                  {renamingFolderId === folder.id ? (
                    <form className="folder-inline-form folder-rename-form" onSubmit={(event) => void submitFolderRename(event, folder)}>
                      <label className="sr-only" htmlFor={`rename-folder-${folder.id}`}>{folder.name} 폴더 이름 변경</label>
                      <input
                        id={`rename-folder-${folder.id}`}
                        autoFocus
                        maxLength={40}
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            setRenamingFolderId(null)
                            setRenameValue('')
                          }
                        }}
                      />
                      <button type="submit" className="folder-form-action" disabled={folderBusy || !renameValue.trim()} aria-label="폴더 이름 저장">
                        <Check size={15} aria-hidden="true" />
                      </button>
                      <button type="button" className="folder-form-action" onClick={() => { setRenamingFolderId(null); setRenameValue('') }} aria-label="이름 변경 취소" disabled={folderBusy}>
                        <X size={15} aria-hidden="true" />
                      </button>
                    </form>
                  ) : (
                    <div className="folder-row">
                      <button
                        type="button"
                        className={`folder-filter-button ${activeFolderId === folder.id ? 'is-active' : ''}`}
                        onClick={() => chooseFolder(folder.id)}
                        aria-current={activeFolderId === folder.id ? 'page' : undefined}
                        aria-label={`${folder.name} 폴더, ${folderCounts.get(folder.id) ?? 0}개. 단어를 이곳에 끌어 놓아 이동할 수 있습니다.`}
                      >
                        <Folder size={17} aria-hidden="true" />
                        <span className="folder-name" title={folder.name}>{folder.name}</span>
                        <span className="folder-count" aria-hidden="true">{folderCounts.get(folder.id) ?? 0}</span>
                      </button>
                      <div className="folder-actions" role="group" aria-label={`${folder.name} 폴더 관리`}>
                        <button type="button" onClick={() => beginRenameFolder(folder)} aria-label={`${folder.name} 폴더 이름 변경`} disabled={folderBusy}>
                          <Edit3 size={14} aria-hidden="true" />
                        </button>
                        <button type="button" className="danger" onClick={() => void removeFolder(folder)} aria-label={`${folder.name} 폴더 삭제`} disabled={folderBusy}>
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          {foldersLoading ? <p className="folder-loading" aria-live="polite">폴더를 불러오는 중…</p> : null}
          <p className="folder-drag-hint"><GripVertical size={14} aria-hidden="true" /> 단어 행이나 카드를 폴더로 끌어 이동하세요.</p>
        </aside>

        <div className="dictionary-main">

      <div className="dictionary-toolbar surface">
        <label className="search-field">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">단어장 검색</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="단어, 뜻, 품사, 메모 검색"
          />
          {query ? (
            <button type="button" className="clear-search" onClick={() => setQuery('')} aria-label="검색어 지우기">
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <label className="select-field">
          <ArrowDownAZ size={18} aria-hidden="true" />
          <span className="sr-only">정렬 방식</span>
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            <option value="newest">최근 추가순</option>
            <option value="oldest">오래된순</option>
            <option value="word-asc">알파벳 A–Z</option>
            <option value="word-desc">알파벳 Z–A</option>
          </select>
        </label>
        <div className="toolbar-divider" aria-hidden="true" />
        <div className="import-controls">
          <label className="sr-only" htmlFor="import-mode">가져오기 방식</label>
          <select
            id="import-mode"
            className="compact-select"
            value={importMode}
            onChange={(event) => setImportMode(event.target.value as ImportMode)}
            title="가져오기 방식"
          >
            <option value="merge">기존 단어와 합치기</option>
            <option value="replace">전체 바꾸기</option>
          </select>
          <input
            ref={importInputRef}
            className="sr-only"
            type="file"
            accept=".json,.csv,application/json,text/csv"
            onChange={(event) => void handleImport(event.target.files?.[0])}
          />
          <button
            type="button"
            className="button button-quiet"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
          >
            <Upload size={17} aria-hidden="true" /> {importing ? '가져오는 중…' : '가져오기'}
          </button>
        </div>
        <div className="export-group" aria-label="내보내기">
          <span className="export-label"><Download size={16} aria-hidden="true" /> 내보내기</span>
          <button type="button" className="format-button" onClick={() => downloadExport(entries, 'json', folders)} disabled={entries.length === 0 && folders.length === 0}>
            <FileJson size={16} aria-hidden="true" /> JSON
          </button>
          <button type="button" className="format-button" onClick={() => downloadExport(entries, 'csv', folders)} disabled={entries.length === 0 && folders.length === 0}>
            <FileSpreadsheet size={16} aria-hidden="true" /> CSV
          </button>
        </div>
      </div>

      {selectedIds.size > 0 ? (
        <div className="selection-bar" aria-live="polite">
          <span><CheckSquare2 size={18} aria-hidden="true" /> {selectedIds.size}개 선택됨</span>
          <div className="selection-actions">
            <label className="selection-move-field">
              <MoveRight size={17} aria-hidden="true" />
              <span className="sr-only">선택한 단어를 이동할 폴더</span>
              <select defaultValue="" onChange={handleBulkMove} disabled={folderBusy} aria-label={`${selectedIds.size}개 단어를 이동할 폴더`}>
                <option value="" disabled>폴더로 이동…</option>
                <option value={UNFILED_DESTINATION}>미분류</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </label>
            <button type="button" className="button button-danger-quiet" onClick={() => void removeWords([...selectedIds], '선택한 단어를')} disabled={folderBusy}>
              <Trash2 size={17} aria-hidden="true" /> 선택 삭제
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="list-skeleton surface" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> 단어장을 불러오는 중이에요…
        </div>
      ) : null}

      {empty ? (
        <div className="empty-state surface">
          <div className="empty-icon"><BookOpen size={30} aria-hidden="true" /></div>
          <h2>아직 저장한 단어가 없어요</h2>
          <p>사진 속 영어를 인식하거나 직접 단어를 추가해 보세요.</p>
          <button type="button" className="button button-primary" onClick={() => openEditor()}>
            <Plus size={18} aria-hidden="true" /> 첫 단어 추가
          </button>
        </div>
      ) : null}

      {noSearchResult ? (
        <div className="empty-state compact surface">
          {query ? <Search size={26} aria-hidden="true" /> : <Folder size={26} aria-hidden="true" />}
          <h2>{query ? `“${query}” 검색 결과가 없어요` : `${activeFolderLabel}에 단어가 없어요`}</h2>
          <p>{query ? '검색어를 바꾸거나 현재 폴더의 다른 단어를 확인해 보세요.' : '다른 폴더에서 단어를 끌어오거나 새 단어를 추가해 보세요.'}</p>
          {query ? (
            <button type="button" className="text-button" onClick={() => setQuery('')}>검색 초기화</button>
          ) : (
            <button type="button" className="button button-primary" onClick={() => openEditor()}><Plus size={17} aria-hidden="true" /> 이 폴더에 단어 추가</button>
          )}
        </div>
      ) : null}

      {!loading && filteredEntries.length > 0 ? (
        <>
          <div className="dictionary-summary">
            <label className="check-label">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
              현재 목록 전체 선택
            </label>
            <span><strong>{activeFolderLabel}</strong> · {filteredEntries.length}개의 단어</span>
          </div>

          <div className="word-table-wrap surface">
            <table className="word-table" style={dictionaryTableStyle}>
              <thead>
                <tr>
                  <th scope="col" className="check-column">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      aria-label="현재 목록 전체 선택"
                    />
                  </th>
                  <th scope="col">단어</th>
                  <th scope="col">한국어 뜻</th>
                  <th scope="col">품사</th>
                  <th scope="col">메모</th>
                  <th scope="col">추가일</th>
                  <th scope="col"><span className="sr-only">동작</span></th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry) => (
                  <tr
                    key={entry.id}
                    className={`${selectedIds.has(entry.id) ? 'is-selected' : ''} ${draggingIds.includes(entry.id) ? 'is-dragging' : ''}`}
                    draggable={!folderBusy}
                    onDragStart={(event) => startWordDrag(event, entry.id)}
                    onDragEnd={finishWordDrag}
                    title="드래그해 폴더로 이동"
                  >
                    <td className="check-column">
                      <input type="checkbox" checked={selectedIds.has(entry.id)} onChange={() => toggleSelected(entry.id)} aria-label={`${entry.word} 선택`} />
                    </td>
                    <td>
                      <div className="word-cell">
                        <span className="drag-handle" aria-hidden="true"><GripVertical size={15} /></span>
                        <div className="word-cell-copy">
                          <div className="word-cell-title">
                            <strong lang="en" title={entry.word}>{entry.word}</strong>
                            <button type="button" className="speak-button" onClick={() => onSpeak(entry.word)} disabled={!speechAvailable} aria-label={`${entry.word} 발음 듣기`} title={speechAvailable ? '발음 듣기' : '기기에 설치된 영어 음성 없음'}>
                              <Volume2 size={16} aria-hidden="true" />
                            </button>
                          </div>
                          <span className="entry-folder-label"><Folder size={11} aria-hidden="true" /> {folderNameForEntry(entry)}</span>
                        </div>
                      </div>
                    </td>
                    <td className={entry.meaning ? '' : 'muted-cell'}>{entry.meaning || '뜻을 입력해 주세요'}</td>
                    <td>{entry.partOfSpeech ? <span className="pos-chip">{entry.partOfSpeech}</span> : <span className="muted-cell">—</span>}</td>
                    <td className="memo-cell">{entry.memo || <span className="muted-cell">—</span>}</td>
                    <td className="date-cell">{formatDate(entry.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="icon-button" onClick={() => openEditor(entry)} aria-label={`${entry.word} 수정`}><Edit3 size={17} aria-hidden="true" /></button>
                        <button type="button" className="icon-button danger" onClick={() => void removeWords([entry.id], `“${entry.word}”을`)} aria-label={`${entry.word} 삭제`}><Trash2 size={17} aria-hidden="true" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="word-card-list">
            {filteredEntries.map((entry) => (
              <article
                key={entry.id}
                className={`word-list-card surface ${selectedIds.has(entry.id) ? 'is-selected' : ''} ${draggingIds.includes(entry.id) ? 'is-dragging' : ''}`}
                draggable={!folderBusy}
                onDragStart={(event) => startWordDrag(event, entry.id)}
                onDragEnd={finishWordDrag}
                aria-label={`${entry.word}, ${folderNameForEntry(entry)}. 드래그해 폴더로 이동할 수 있습니다.`}
              >
                <label className="card-checkbox">
                  <input type="checkbox" checked={selectedIds.has(entry.id)} onChange={() => toggleSelected(entry.id)} />
                  <span className="sr-only">{entry.word} 선택</span>
                </label>
                <div className="word-card-main">
                  <div className="word-card-title">
                    <h2 lang="en">{entry.word}</h2>
                    <button type="button" className="speak-button" onClick={() => onSpeak(entry.word)} disabled={!speechAvailable} aria-label={`${entry.word} 발음 듣기`}>
                      <Volume2 size={17} aria-hidden="true" />
                    </button>
                  </div>
                  <p className={entry.meaning ? 'card-meaning' : 'card-meaning is-empty'}>{entry.meaning || '뜻을 입력해 주세요'}</p>
                  <div className="card-meta">
                    <span className="entry-folder-label"><Folder size={11} aria-hidden="true" /> {folderNameForEntry(entry)}</span>
                    {entry.partOfSpeech ? <span className="pos-chip">{entry.partOfSpeech}</span> : null}
                    {entry.memo ? <span>{entry.memo}</span> : null}
                  </div>
                </div>
                <div className="card-actions">
                  <span className="card-drag-handle" title="드래그해 폴더로 이동" aria-hidden="true"><GripVertical size={17} /></span>
                  <button type="button" className="icon-button" onClick={() => openEditor(entry)} aria-label={`${entry.word} 수정`}><Edit3 size={18} aria-hidden="true" /></button>
                  <button type="button" className="icon-button danger" onClick={() => void removeWords([entry.id], `“${entry.word}”을`)} aria-label={`${entry.word} 삭제`}><Trash2 size={18} aria-hidden="true" /></button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}

        </div>
      </div>

      {editing ? (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeEditor()}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="word-editor-title">
            <div className="modal-header">
              <div>
                <span className="eyebrow">WORD DETAILS</span>
                <h2 id="word-editor-title">{editing === 'new' ? '새 단어 추가' : '단어 수정'}</h2>
              </div>
              <button type="button" className="icon-button" onClick={closeEditor} aria-label="닫기"><X size={20} aria-hidden="true" /></button>
            </div>
            <form onSubmit={(event) => void saveWord(event)}>
              <div className="form-grid">
                <label className="field-label">
                  <span>영어 단어 <em>필수</em></span>
                  <input autoFocus required value={form.word} onChange={(event) => setForm({ ...form, word: event.target.value })} placeholder="예: curious" lang="en" />
                </label>
                <label className="field-label">
                  <span>품사</span>
                  <input list="parts-of-speech" value={form.partOfSpeech} onChange={(event) => setForm({ ...form, partOfSpeech: event.target.value })} placeholder="예: 형용사" />
                  <small className="field-help">비워 두면 오프라인 사전에서 자동으로 채워요.</small>
                  <datalist id="parts-of-speech">
                    <option value="명사" /><option value="동사" /><option value="형용사" /><option value="부사" /><option value="전치사" /><option value="접속사" />
                  </datalist>
                </label>
                <label className="field-label full-width">
                  <span>폴더</span>
                  <select value={form.folderId} onChange={(event) => setForm({ ...form, folderId: event.target.value })}>
                    <option value="">미분류</option>
                    {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                  </select>
                </label>
                <label className="field-label full-width">
                  <span>한국어 뜻</span>
                  <input value={form.meaning} onChange={(event) => setForm({ ...form, meaning: event.target.value })} placeholder="예: 호기심이 많은" />
                  <small className="field-help">비워 두면 자동 뜻을 제안하며, 저장 후 언제든 수정할 수 있어요.</small>
                </label>
                <label className="field-label full-width">
                  <span>메모</span>
                  <textarea rows={3} value={form.memo} onChange={(event) => setForm({ ...form, memo: event.target.value })} placeholder="예문이나 기억할 내용을 적어 보세요." />
                </label>
              </div>
              <div className="modal-actions">
                <button type="button" className="button button-quiet" onClick={closeEditor}>취소</button>
                <button type="submit" className="button button-primary" disabled={saving || !form.word.trim()}>{saving ? '저장하는 중…' : '저장하기'}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  )
}
