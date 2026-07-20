import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownAZ,
  BookOpen,
  CheckSquare2,
  Download,
  Edit3,
  FileJson,
  FileSpreadsheet,
  Plus,
  Search,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import type { ImportMode, WordEntry, WordEntryInput } from '../types'
import { deleteMany, DuplicateWordError, importEntries, put } from '../lib/db'
import { downloadExport, parseImportFile } from '../lib/importExport'
import type { ToastKind } from './Toast'

type SortKey = 'newest' | 'oldest' | 'word-asc' | 'word-desc'

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
}

const emptyForm: WordFormState = {
  word: '',
  meaning: '',
  partOfSpeech: '',
  memo: '',
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
  const [importMode, setImportMode] = useState<ImportMode>('merge')
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const filteredEntries = useMemo(() => {
    const collator = new Intl.Collator('en', { sensitivity: 'base' })
    const result = entries.filter((entry) => matchesSearch(entry, query.trim()))
    return [...result].sort((left, right) => {
      if (sortKey === 'word-asc') return collator.compare(left.word, right.word)
      if (sortKey === 'word-desc') return collator.compare(right.word, left.word)
      if (sortKey === 'oldest') return left.createdAt.localeCompare(right.createdAt)
      return right.createdAt.localeCompare(left.createdAt)
    })
  }, [entries, query, sortKey])

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

  const openEditor = (entry?: WordEntry) => {
    setEditing(entry ?? 'new')
    setForm(
      entry
        ? {
            word: entry.word,
            meaning: entry.meaning,
            partOfSpeech: entry.partOfSpeech,
            memo: entry.memo,
          }
        : emptyForm,
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
      }
      await put(input)
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
      if (parsed.entries.length === 0) {
        const firstIssue = parsed.issues[0]?.message
        throw new Error(firstIssue || '가져올 수 있는 단어가 없어요.')
      }
      const result = await importEntries(parsed.entries, importMode)
      await onChanged()
      const details = [
        `${result.added.length}개 가져옴`,
        result.duplicates.length ? `${result.duplicates.length}개 중복 건너뜀` : '',
        parsed.rejectedCount ? `${parsed.rejectedCount}개 오류 제외` : '',
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
        <button type="button" className="button button-primary" onClick={() => openEditor()}>
          <Plus size={18} aria-hidden="true" /> 직접 추가
        </button>
      </div>

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
          <button type="button" className="format-button" onClick={() => downloadExport(entries, 'json')} disabled={entries.length === 0}>
            <FileJson size={16} aria-hidden="true" /> JSON
          </button>
          <button type="button" className="format-button" onClick={() => downloadExport(entries, 'csv')} disabled={entries.length === 0}>
            <FileSpreadsheet size={16} aria-hidden="true" /> CSV
          </button>
        </div>
      </div>

      {selectedIds.size > 0 ? (
        <div className="selection-bar" role="status">
          <span><CheckSquare2 size={18} aria-hidden="true" /> {selectedIds.size}개 선택됨</span>
          <button type="button" className="button button-danger-quiet" onClick={() => void removeWords([...selectedIds], '선택한 단어를')}>
            <Trash2 size={17} aria-hidden="true" /> 선택 삭제
          </button>
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
          <Search size={26} aria-hidden="true" />
          <h2>“{query}” 검색 결과가 없어요</h2>
          <button type="button" className="text-button" onClick={() => setQuery('')}>검색 초기화</button>
        </div>
      ) : null}

      {!loading && filteredEntries.length > 0 ? (
        <>
          <div className="dictionary-summary">
            <label className="check-label">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
              현재 목록 전체 선택
            </label>
            <span>{filteredEntries.length}개의 단어</span>
          </div>

          <div className="word-table-wrap surface">
            <table className="word-table">
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
                  <tr key={entry.id} className={selectedIds.has(entry.id) ? 'is-selected' : ''}>
                    <td className="check-column">
                      <input type="checkbox" checked={selectedIds.has(entry.id)} onChange={() => toggleSelected(entry.id)} aria-label={`${entry.word} 선택`} />
                    </td>
                    <td>
                      <div className="word-cell">
                        <strong lang="en">{entry.word}</strong>
                        <button type="button" className="speak-button" onClick={() => onSpeak(entry.word)} disabled={!speechAvailable} aria-label={`${entry.word} 발음 듣기`} title={speechAvailable ? '발음 듣기' : '기기에 설치된 영어 음성 없음'}>
                          <Volume2 size={16} aria-hidden="true" />
                        </button>
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
              <article key={entry.id} className={`word-list-card surface ${selectedIds.has(entry.id) ? 'is-selected' : ''}`}>
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
                    {entry.partOfSpeech ? <span className="pos-chip">{entry.partOfSpeech}</span> : null}
                    {entry.memo ? <span>{entry.memo}</span> : null}
                  </div>
                </div>
                <div className="card-actions">
                  <button type="button" className="icon-button" onClick={() => openEditor(entry)} aria-label={`${entry.word} 수정`}><Edit3 size={18} aria-hidden="true" /></button>
                  <button type="button" className="icon-button danger" onClick={() => void removeWords([entry.id], `“${entry.word}”을`)} aria-label={`${entry.word} 삭제`}><Trash2 size={18} aria-hidden="true" /></button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}

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
                  <datalist id="parts-of-speech">
                    <option value="명사" /><option value="동사" /><option value="형용사" /><option value="부사" /><option value="전치사" /><option value="접속사" />
                  </datalist>
                </label>
                <label className="field-label full-width">
                  <span>한국어 뜻</span>
                  <input value={form.meaning} onChange={(event) => setForm({ ...form, meaning: event.target.value })} placeholder="예: 호기심이 많은" />
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
