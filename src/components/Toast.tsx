import { CheckCircle2, CircleAlert, X } from 'lucide-react'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastMessage {
  id: number
  kind: ToastKind
  text: string
}

interface ToastProps {
  toast: ToastMessage | null
  onClose: () => void
}

export function Toast({ toast, onClose }: ToastProps) {
  if (!toast) return null
  const Icon = toast.kind === 'success' ? CheckCircle2 : CircleAlert
  return (
    <div
      className={`toast toast-${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
    >
      <Icon size={20} aria-hidden="true" />
      <span>{toast.text}</span>
      <button type="button" className="icon-button toast-close" onClick={onClose} aria-label="알림 닫기">
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  )
}
