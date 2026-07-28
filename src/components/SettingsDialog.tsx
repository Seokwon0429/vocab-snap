import { useEffect } from 'react'
import {
  HardDriveDownload,
  RefreshCw,
  Settings,
  Trash2,
  Volume2,
  X,
} from 'lucide-react'
import type { AuthUser } from '../lib/auth'
import type { OfflineStudySnapshot } from '../lib/offlineStudy'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  autoSpeak: boolean
  onAutoSpeakChange: (enabled: boolean) => void
  speechAvailable: boolean
  user: AuthUser | null
  snapshot: OfflineStudySnapshot | null
  snapshotLoading: boolean
  snapshotSaving: boolean
  onSaveSnapshot: () => void
  onClearSnapshot: () => void
}

function formatSavedAt(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export function SettingsDialog({
  open,
  onClose,
  autoSpeak,
  onAutoSpeakChange,
  speechAvailable,
  user,
  snapshot,
  snapshotLoading,
  snapshotSaving,
  onSaveSnapshot,
  onClearSnapshot,
}: SettingsDialogProps) {
  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !snapshotSaving) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, open, snapshotSaving])

  if (!open) return null

  const isCurrentUsersSnapshot = Boolean(
    user && snapshot?.ownerId === user.id,
  )

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !snapshotSaving) onClose()
      }}
    >
      <section
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-header settings-modal-header">
          <div>
            <span className="eyebrow"><Settings size={13} /> SETTINGS</span>
            <h2 id="settings-title">학습 설정</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={snapshotSaving}
            aria-label="설정 창 닫기"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>

        <div className="settings-sections">
          <section className="settings-section" aria-labelledby="speech-setting-title">
            <div className="settings-section-heading">
              <span className="settings-section-icon" aria-hidden="true"><Volume2 size={19} /></span>
              <div>
                <h3 id="speech-setting-title">퀴즈 자동 발음</h3>
                <p>새 단어 카드가 나타날 때 기기 내장 영어 음성으로 한 번 읽어요.</p>
              </div>
            </div>
            <label className={`settings-toggle ${!speechAvailable ? 'is-disabled' : ''}`}>
              <span>
                <strong>단어가 나오면 바로 발음</strong>
                <small>{speechAvailable ? '이 설정은 현재 기기에만 저장됩니다.' : '사용할 수 있는 기기 내장 영어 음성이 없어요.'}</small>
              </span>
              <input
                type="checkbox"
                checked={autoSpeak}
                disabled={!speechAvailable}
                onChange={(event) => onAutoSpeakChange(event.target.checked)}
              />
            </label>
          </section>

          <section className="settings-section" aria-labelledby="offline-setting-title">
            <div className="settings-section-heading">
              <span className="settings-section-icon" aria-hidden="true"><HardDriveDownload size={19} /></span>
              <div>
                <h3 id="offline-setting-title">로그인 없는 오프라인 학습본</h3>
                <p>이 기기에 단어와 폴더를 복사해 로그아웃 뒤에도 단어장과 퀴즈를 열어요.</p>
              </div>
            </div>

            <div className="offline-copy-status" aria-live="polite">
              {snapshotLoading ? (
                <p>저장된 학습본을 확인하는 중…</p>
              ) : snapshot ? (
                <div>
                  <strong>{snapshot.ownerUsername} · 단어 {snapshot.entries.length}개</strong>
                  <span>마지막 저장 {formatSavedAt(snapshot.savedAt)}</span>
                </div>
              ) : (
                <div>
                  <strong>아직 이 기기에 저장된 학습본이 없어요.</strong>
                  <span>로그인한 뒤 현재 단어장을 한 번 저장해 주세요.</span>
                </div>
              )}
            </div>

            <p className="settings-warning">
              오프라인 학습본은 읽기 전용입니다. 로그아웃 상태의 수정과 퀴즈 결과는 저장되지 않으며,
              메모도 함께 복사되므로 공용 기기에는 저장하지 마세요.
            </p>

            <div className="settings-offline-actions">
              {user ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={onSaveSnapshot}
                  disabled={snapshotSaving}
                >
                  <RefreshCw size={17} className={snapshotSaving ? 'spin-icon' : ''} aria-hidden="true" />
                  {snapshotSaving
                    ? '저장하는 중…'
                    : isCurrentUsersSnapshot
                      ? '현재 단어장으로 업데이트'
                      : '현재 단어장 기기에 저장'}
                </button>
              ) : (
                <p className="settings-login-help">단어장을 새로 저장하거나 업데이트하려면 로그인해 주세요.</p>
              )}
              {snapshot ? (
                <button
                  type="button"
                  className="button button-danger-quiet"
                  onClick={onClearSnapshot}
                  disabled={snapshotSaving}
                >
                  <Trash2 size={17} aria-hidden="true" /> 기기 학습본 삭제
                </button>
              ) : null}
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}
