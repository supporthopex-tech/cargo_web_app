import { useEffect, type ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: string
}

export default function Modal({ open, onClose, title, children, width = 'max-w-lg' }: Props) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#071b35]/55 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-[6px] sm:items-center sm:p-4">
      <div className={`modal-surface flex max-h-[calc(100dvh-1rem)] w-full flex-col sm:max-h-[90dvh] ${width}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div><div className="text-[10px] font-bold uppercase tracking-[0.14em] text-navy-500">Hopex Express Cargo</div><h2 className="mt-0.5 text-base font-bold text-slate-900">{title}</h2></div>
          <button onClick={onClose} aria-label="Close dialog" className="flex size-11 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
      </div>
    </div>
  )
}
