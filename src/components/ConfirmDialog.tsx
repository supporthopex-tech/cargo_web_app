interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', danger = true, busy = false, onConfirm, onCancel }: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#071b35]/55 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-[6px] sm:items-center sm:p-4">
      <div className="modal-surface w-full max-w-sm p-5 sm:p-6" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className={`size-10 rounded-full flex items-center justify-center mb-4 ${danger ? 'bg-red-50' : 'bg-amber-50'}`}>
          <svg className={`size-5 ${danger ? 'text-red-500' : 'text-amber-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="mb-1 text-base font-bold text-slate-900">{title}</h3>
        <p className="mb-5 text-sm leading-6 text-slate-500">{message}</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <button onClick={onCancel} disabled={busy} className="min-h-11 flex-1 rounded-lg border border-slate-200 text-sm text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`min-h-11 flex-1 rounded-lg text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${danger ? 'bg-red-500 hover:bg-red-600' : 'bg-amber-500 hover:bg-amber-600'}`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
