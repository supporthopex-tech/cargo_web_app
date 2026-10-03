import { useEffect, useState } from 'react'

interface Props {
  open: boolean
  title: string
  message: string
  /** The exact string the user must type to enable the confirm button — a
   *  tracking number, company name, packing list #, etc. Always something
   *  already visible on screen, never a made-up phrase. */
  confirmText: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

// A stricter ConfirmDialog for irreversible actions (hard deletes) — the
// confirm button stays disabled until the user types the exact value back,
// so a reflexive double-click can't destroy something that can't be
// restored. Reversible actions (archive, void, disable) use the plain
// ConfirmDialog instead; this is reserved for the "never-hard-delete" /
// "safe-delete" boundary described in the Controlled Deletion audit.
export default function TypedConfirmDialog({ open, title, message, confirmText, confirmLabel = 'Delete', onConfirm, onCancel }: Props) {
  const [value, setValue] = useState('')

  useEffect(() => { if (open) setValue('') }, [open])

  if (!open) return null

  const matches = value.trim() === confirmText.trim() && confirmText.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#071b35]/55 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-[6px] sm:items-center sm:p-4">
      <div className="modal-surface w-full max-w-sm p-5 sm:p-6" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-red-50">
          <svg className="size-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="mb-1 text-base font-bold text-slate-900">{title}</h3>
        <p className="mb-4 text-sm leading-6 text-slate-500">{message}</p>
        <label className="mb-5 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">
            Type <span className="font-mono font-bold text-slate-800">{confirmText}</span> to confirm
          </span>
          <input
            autoFocus
            value={value}
            onChange={event => setValue(event.target.value)}
            className="form-input font-mono"
            placeholder={confirmText}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <button onClick={onCancel} className="min-h-11 flex-1 rounded-lg border border-slate-200 text-sm text-slate-600 transition-colors hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!matches}
            className="min-h-11 flex-1 rounded-lg bg-red-500 text-sm font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
