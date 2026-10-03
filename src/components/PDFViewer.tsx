import { useEffect } from 'react'

interface Props {
  url: string
  title: string
  onClose: () => void
  onDownload?: () => void
}

export default function PDFViewer({ url, title, onClose, onDownload }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-black/85 pb-[env(safe-area-inset-bottom)]">
      {/* Header toolbar */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 bg-[#0c1c35] px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:gap-3 sm:px-4 sm:py-3">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <DocIcon />
          <span className="text-white text-sm font-semibold truncate">{title}</span>
        </div>
        <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:flex-shrink-0 sm:items-center">
          {onDownload && (
            <button onClick={onDownload}
              className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-white transition-colors hover:opacity-90 sm:px-3"
              style={{ backgroundColor: 'rgb(249,115,22)' }}>
              <DownloadIcon /> Download
            </button>
          )}
          <a href={url} target="_blank" rel="noreferrer"
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-white/20 px-2 text-xs font-medium text-white transition-colors hover:bg-white/10 sm:px-3">
            <ExternalIcon /> Open in Tab
          </a>
          <button onClick={onClose}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-white/20 px-2 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white sm:px-3">
            <XIcon /> Close
          </button>
        </div>
      </div>

      {/* PDF iframe */}
      <div className="flex-1 overflow-hidden">
        <iframe
          src={`${url}#toolbar=1&navpanes=0&scrollbar=1&view=FitH`}
          className="w-full h-full border-0"
          title={title}
        />
      </div>
    </div>
  )
}

const DocIcon = () => <svg className="size-4 text-slate-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
const DownloadIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
const ExternalIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
const XIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
