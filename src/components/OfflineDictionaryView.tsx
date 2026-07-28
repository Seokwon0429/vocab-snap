import { useMemo, useState } from 'react'
import {
  ArrowDownAZ,
  BookOpen,
  Folder,
  FolderOpen,
  HardDrive,
  Search,
  Volume2,
  X,
} from 'lucide-react'
import type { VocabularyFolder, WordEntry } from '../types'

type SortKey = 'newest' | 'oldest' | 'word-asc' | 'word-desc'
type FolderFilter = 'all' | 'unfiled' | string

interface OfflineDictionaryViewProps {
  entries: readonly WordEntry[]
  folders: readonly VocabularyFolder[]
  speechAvailable: boolean
  onSpeak: (word: string) => void
}

function matchesSearch(entry: WordEntry, query: string): boolean {
  if (!query) return true
  return [entry.word, entry.meaning, entry.partOfSpeech, entry.memo]
    .join(' ')
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase())
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

export function OfflineDictionaryView({
  entries,
  folders,
  speechAvailable,
  onSpeak,
}: OfflineDictionaryViewProps) {
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('word-asc')
  const [activeFolderId, setActiveFolderId] = useState<FolderFilter>('all')

  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  )
  const validFolderIds = useMemo(
    () => new Set(folders.map((folder) => folder.id)),
    [folders],
  )
  const folderCounts = useMemo(() => {
    const counts = new Map(folders.map((folder) => [folder.id, 0]))
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
    return folderById.get(activeFolderId)?.name ?? '전체 단어'
  }, [activeFolderId, folderById])
  const filteredEntries = useMemo(() => {
    const collator = new Intl.Collator('en', { sensitivity: 'base' })
    const filtered = entries.filter((entry) => {
      const inFolder = activeFolderId === 'all'
        || (activeFolderId === 'unfiled'
          ? !entry.folderId || !validFolderIds.has(entry.folderId)
          : entry.folderId === activeFolderId)
      return inFolder && matchesSearch(entry, query.trim())
    })

    return [...filtered].sort((left, right) => {
      if (sortKey === 'word-asc') return collator.compare(left.word, right.word)
      if (sortKey === 'word-desc') return collator.compare(right.word, left.word)
      if (sortKey === 'oldest') return left.createdAt.localeCompare(right.createdAt)
      return right.createdAt.localeCompare(left.createdAt)
    })
  }, [activeFolderId, entries, query, sortKey, validFolderIds])

  const folderNameForEntry = (entry: WordEntry) =>
    entry.folderId ? folderById.get(entry.folderId)?.name ?? '미분류' : '미분류'

  return (
    <section className="page dictionary-page offline-dictionary-page" aria-labelledby="dictionary-title">
      <div className="page-heading dictionary-heading">
        <div>
          <span className="eyebrow">OFFLINE STUDY COPY</span>
          <h1 id="dictionary-title">오프라인 단어장</h1>
          <p>로그인 없이 보는 기기 학습본입니다. 검색, 발음 듣기와 퀴즈를 사용할 수 있어요.</p>
        </div>
      </div>

      <div className="offline-readonly-note" role="status">
        <HardDrive size={18} aria-hidden="true" />
        <span><strong>읽기 전용</strong> · 단어 수정과 퀴즈 결과는 저장되지 않아요.</span>
      </div>

      <div className="dictionary-workspace">
        <aside className="folder-panel surface" aria-labelledby="folder-panel-title">
          <div className="folder-panel-header">
            <div>
              <span className="folder-panel-kicker">BROWSE</span>
              <h2 id="folder-panel-title"><FolderOpen size={18} aria-hidden="true" /> 폴더</h2>
            </div>
          </div>

          <nav className="folder-navigation" aria-label="오프라인 단어장 폴더">
            <ul className="folder-list">
              <li className="folder-list-item folder-list-item-system">
                <button
                  type="button"
                  className={`folder-filter-button ${activeFolderId === 'all' ? 'is-active' : ''}`}
                  onClick={() => setActiveFolderId('all')}
                  aria-current={activeFolderId === 'all' ? 'page' : undefined}
                >
                  <BookOpen size={17} aria-hidden="true" />
                  <span className="folder-name">전체 단어</span>
                  <span className="folder-count" aria-hidden="true">{entries.length}</span>
                </button>
              </li>
              <li className="folder-list-item folder-list-item-system">
                <button
                  type="button"
                  className={`folder-filter-button ${activeFolderId === 'unfiled' ? 'is-active' : ''}`}
                  onClick={() => setActiveFolderId('unfiled')}
                  aria-current={activeFolderId === 'unfiled' ? 'page' : undefined}
                >
                  <Folder size={17} aria-hidden="true" />
                  <span className="folder-name">미분류</span>
                  <span className="folder-count" aria-hidden="true">{unfiledCount}</span>
                </button>
              </li>
              {folders.map((folder) => (
                <li key={folder.id} className="folder-list-item">
                  <div className="folder-row">
                    <button
                      type="button"
                      className={`folder-filter-button ${activeFolderId === folder.id ? 'is-active' : ''}`}
                      onClick={() => setActiveFolderId(folder.id)}
                      aria-current={activeFolderId === folder.id ? 'page' : undefined}
                    >
                      <Folder size={17} aria-hidden="true" />
                      <span className="folder-name" title={folder.name}>{folder.name}</span>
                      <span className="folder-count" aria-hidden="true">{folderCounts.get(folder.id) ?? 0}</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <div className="dictionary-main">
          <div className="dictionary-toolbar offline-dictionary-toolbar surface">
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
                <option value="word-asc">알파벳 A–Z</option>
                <option value="word-desc">알파벳 Z–A</option>
                <option value="newest">최근 추가순</option>
                <option value="oldest">오래된순</option>
              </select>
            </label>
          </div>

          {entries.length === 0 ? (
            <div className="empty-state surface">
              <div className="empty-icon"><BookOpen size={30} aria-hidden="true" /></div>
              <h2>저장된 단어가 없어요</h2>
              <p>로그인한 뒤 설정에서 단어가 있는 현재 단어장을 다시 저장해 주세요.</p>
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="empty-state compact surface">
              {query ? <Search size={26} aria-hidden="true" /> : <Folder size={26} aria-hidden="true" />}
              <h2>{query ? `“${query}” 검색 결과가 없어요` : `${activeFolderLabel}에 단어가 없어요`}</h2>
              <button type="button" className="text-button" onClick={() => { setQuery(''); setActiveFolderId('all') }}>전체 단어 보기</button>
            </div>
          ) : (
            <>
              <div className="dictionary-summary offline-dictionary-summary">
                <span><strong>{activeFolderLabel}</strong> · {filteredEntries.length}개의 단어</span>
              </div>

              <div className="offline-word-table-wrap surface">
                <table className="offline-word-table">
                  <thead>
                    <tr>
                      <th scope="col">번호</th>
                      <th scope="col">단어</th>
                      <th scope="col">한국어 뜻</th>
                      <th scope="col">품사</th>
                      <th scope="col">메모</th>
                      <th scope="col">추가일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.map((entry, index) => (
                      <tr key={entry.id}>
                        <td className="number-column">{index + 1}</td>
                        <td>
                          <div className="word-cell-copy">
                            <div className="word-cell-title">
                              <strong lang="en">{entry.word}</strong>
                              <button
                                type="button"
                                className="speak-button"
                                onClick={() => onSpeak(entry.word)}
                                disabled={!speechAvailable}
                                aria-label={`${entry.word} 발음 듣기`}
                              >
                                <Volume2 size={16} aria-hidden="true" />
                              </button>
                            </div>
                            <span className="entry-folder-label"><Folder size={11} aria-hidden="true" /> {folderNameForEntry(entry)}</span>
                          </div>
                        </td>
                        <td className={entry.meaning ? '' : 'muted-cell'}>{entry.meaning || '뜻 없음'}</td>
                        <td>{entry.partOfSpeech ? <span className="pos-chip">{entry.partOfSpeech}</span> : <span className="muted-cell">—</span>}</td>
                        <td className="memo-cell">{entry.memo || <span className="muted-cell">—</span>}</td>
                        <td className="date-cell">{formatDate(entry.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="offline-word-card-list">
                {filteredEntries.map((entry, index) => (
                  <article key={entry.id} className="offline-word-card surface" aria-label={`${index + 1}번째 단어, ${entry.word}`}>
                    <span className="word-card-number" aria-hidden="true">{index + 1}번</span>
                    <div className="word-card-title">
                      <h2 lang="en">{entry.word}</h2>
                      <button
                        type="button"
                        className="speak-button"
                        onClick={() => onSpeak(entry.word)}
                        disabled={!speechAvailable}
                        aria-label={`${entry.word} 발음 듣기`}
                      >
                        <Volume2 size={17} aria-hidden="true" />
                      </button>
                    </div>
                    <p className={entry.meaning ? 'card-meaning' : 'card-meaning is-empty'}>{entry.meaning || '뜻 없음'}</p>
                    <div className="card-meta">
                      <span className="entry-folder-label"><Folder size={11} aria-hidden="true" /> {folderNameForEntry(entry)}</span>
                      {entry.partOfSpeech ? <span className="pos-chip">{entry.partOfSpeech}</span> : null}
                      {entry.memo ? <span>{entry.memo}</span> : null}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
