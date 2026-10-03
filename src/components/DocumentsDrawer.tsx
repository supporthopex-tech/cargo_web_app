import { useState, useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { formatAmount } from '../types'
import { generateInvoicePDF, printPaymentReceipt, printPackingList, printShippingLabel } from '../lib/pdf'
import { shipmentFinancialSummary } from '../lib/accounting'
import PDFViewer from './PDFViewer'
import toast from 'react-hot-toast'

interface Props {
  open: boolean
  onClose: () => void
}

type DocType = 'all' | 'invoice' | 'receipt' | 'packing-list' | 'label'

const TYPE_LABELS: Record<Exclude<DocType, 'all'>, string> = {
  invoice: 'Invoice',
  receipt: 'Receipt',
  'packing-list': 'Packing List',
  label: 'Shipping Label',
}

const TYPE_COLORS: Record<Exclude<DocType, 'all'>, string> = {
  invoice: 'bg-blue-100 text-blue-700',
  receipt: 'bg-emerald-100 text-emerald-700',
  'packing-list': 'bg-violet-100 text-violet-700',
  label: 'bg-amber-100 text-amber-700',
}

export default function DocumentsDrawer({ open, onClose }: Props) {
  const { shipments, customers, payments, packingLists, packingBoxes, packingAllocations, settings, getPaymentsForShipment, getExtraChargesForShipment } = useAppStore()
  const [tab, setTab] = useState<DocType>('all')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [viewer, setViewer] = useState<{ url: string; title: string; downloadFn: () => void } | null>(null)

  const getCustomer = (id: string) => customers.find(c => c.id === id)

  type DocItem = {
    id: string
    type: Exclude<DocType, 'all'>
    number: string
    label: string
    customer: string
    date: string
    amount?: string
    statusBadge?: string
    statusColor?: string
    shipmentId?: string
    paymentId?: string
    packingListId?: string
  }

  const docs = useMemo((): DocItem[] => {
    const result: DocItem[] = []

    // Invoices (one per shipment)
    shipments.forEach(s => {
      const c = getCustomer(s.customerId)
      const financial = shipmentFinancialSummary(s.invoiceAmount ?? s.totalAmount, s.amountPaid, getExtraChargesForShipment(s.id))
      const ps = financial.paymentStatus
      result.push({
        id: `inv-${s.id}`,
        type: 'invoice',
        number: `INV-${s.trackingNumber}`,
        label: `Invoice — ${s.trackingNumber}`,
        customer: c?.company || 'Unknown',
        date: s.createdAt,
        amount: formatAmount(financial.totalDue, s.invoiceCurrency ?? s.currency),
        statusBadge: ps,
        statusColor: ps === 'Paid' ? 'bg-emerald-100 text-emerald-700' : ps === 'Partially Paid' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700',
        shipmentId: s.id,
      })
    })

    // Payment receipts
    payments.forEach(p => {
      const s = shipments.find(s => s.id === p.shipmentId)
      const c = s ? getCustomer(s.customerId) : undefined
      result.push({
        id: `rct-${p.id}`,
        type: 'receipt',
        number: p.receiptNumber,
        label: `Receipt — ${p.receiptNumber}`,
        customer: c?.company || 'Unknown',
        date: p.date,
        amount: formatAmount(p.amount, p.currency),
        paymentId: p.id,
        shipmentId: p.shipmentId,
      })
    })

    // Packing lists
    packingLists.forEach(pl => {
      result.push({
        id: `pl-${pl.id}`,
        type: 'packing-list',
        number: pl.listId,
        label: `Packing List — ${pl.listId}`,
        customer: `${pl.shipmentIds.length} shipments`,
        date: pl.createdAt,
        statusBadge: pl.status,
        statusColor: pl.status === 'Dispatched' ? 'bg-emerald-100 text-emerald-700' : pl.status === 'Closed' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700',
        packingListId: pl.id,
      })
    })

    // Shipping labels (one per shipment)
    shipments.forEach(s => {
      const c = getCustomer(s.customerId)
      result.push({
        id: `lbl-${s.id}`,
        type: 'label',
        number: `LBL-${s.trackingNumber}`,
        label: `Shipping Label — ${s.trackingNumber}`,
        customer: c?.company || 'Unknown',
        date: s.createdAt,
        shipmentId: s.id,
      })
    })

    return result
  }, [shipments, customers, payments, packingLists, packingBoxes, packingAllocations])

  const filtered = useMemo(() => {
    let list = tab === 'all' ? docs : docs.filter(d => d.type === tab)
    if (q) {
      const lq = q.toLowerCase()
      list = list.filter(d => d.number.toLowerCase().includes(lq) || d.customer.toLowerCase().includes(lq) || d.label.toLowerCase().includes(lq))
    }
    return list.sort((a, b) => b.date.localeCompare(a.date))
  }, [docs, tab, q])

  async function resolveDoc(doc: DocItem): Promise<{ url: string; downloadFn: () => void } | null> {
    if (doc.type === 'invoice' && doc.shipmentId) {
      const s = shipments.find(s => s.id === doc.shipmentId)!
      const c = getCustomer(s.customerId)
      const pmts = getPaymentsForShipment(s.id)
      const url = await generateInvoicePDF(s, c, pmts, settings, getExtraChargesForShipment(s.id), 'view')
      return { url, downloadFn: () => generateInvoicePDF(s, c, pmts, settings, getExtraChargesForShipment(s.id), 'download') }
    }
    if (doc.type === 'receipt' && doc.paymentId && doc.shipmentId) {
      const p = payments.find(p => p.id === doc.paymentId)!
      const s = shipments.find(s => s.id === doc.shipmentId)!
      const c = getCustomer(s.customerId)
      const pmts = getPaymentsForShipment(s.id)
      const url = await printPaymentReceipt(p, s, c, settings, pmts, getExtraChargesForShipment(s.id), 'view')
      return { url, downloadFn: () => printPaymentReceipt(p, s, c, settings, pmts, getExtraChargesForShipment(s.id), 'download') }
    }
    if (doc.type === 'packing-list' && doc.packingListId) {
      const pl = packingLists.find(pl => pl.id === doc.packingListId)!
      const plShips = shipments.filter(s => pl.shipmentIds.includes(s.id))
      const plBoxes = packingBoxes.filter(box => box.packingListId === pl.id)
      const url = await printPackingList(pl, plShips, plBoxes, packingAllocations, customers, settings, 'view')
      return { url, downloadFn: () => printPackingList(pl, plShips, plBoxes, packingAllocations, customers, settings, 'download') }
    }
    if (doc.type === 'label' && doc.shipmentId) {
      const s = shipments.find(s => s.id === doc.shipmentId)!
      const c = getCustomer(s.customerId)
      const url = await printShippingLabel(s, c, settings, 'view')
      return { url, downloadFn: () => printShippingLabel(s, c, settings, 'download') }
    }
    return null
  }

  async function handleView(doc: DocItem) {
    setLoading(doc.id)
    try {
      const result = await resolveDoc(doc)
      if (result) setViewer({ url: result.url, title: doc.label, downloadFn: result.downloadFn })
    } catch {
      toast.error('Failed to generate document')
    } finally {
      setLoading(null)
    }
  }

  async function handleDownload(doc: DocItem) {
    setLoading(`dl-${doc.id}`)
    try {
      const result = await resolveDoc(doc)
      result?.downloadFn()
      toast.success('Document downloaded!')
    } catch {
      toast.error('Failed to generate document')
    } finally {
      setLoading(null)
    }
  }

  const counts: Record<DocType, number> = {
    all: docs.length,
    invoice: docs.filter(d => d.type === 'invoice').length,
    receipt: docs.filter(d => d.type === 'receipt').length,
    'packing-list': docs.filter(d => d.type === 'packing-list').length,
    label: docs.filter(d => d.type === 'label').length,
  }

  const TABS: { key: DocType; label: string; icon: React.ReactNode }[] = [
    { key: 'all', label: 'All', icon: <GridIcon /> },
    { key: 'invoice', label: 'Invoices', icon: <InvoiceIcon /> },
    { key: 'receipt', label: 'Receipts', icon: <ReceiptIcon /> },
    { key: 'packing-list', label: 'Packing Lists', icon: <ListIcon /> },
    { key: 'label', label: 'Labels', icon: <TagIcon /> },
  ]

  return (
    <>
      {/* Backdrop */}
      {open && <div className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm" onClick={onClose} />}

      {/* Drawer */}
      <div className={`fixed right-0 top-0 z-40 flex h-[100dvh] w-full max-w-[420px] flex-col bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl transition-transform duration-300 ease-out ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0" style={{ backgroundColor: 'rgb(12,28,53)' }}>
          <div className="flex items-center gap-2.5">
            <FolderIcon />
            <div>
              <h2 className="text-sm font-bold text-white">Documents</h2>
              <p className="text-[10px] text-slate-400">{docs.length} documents total</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors">
            <XIcon />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-slate-100 flex-shrink-0">
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-slate-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search documents…" className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none bg-slate-50" />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 py-2 border-b border-slate-100 overflow-x-auto flex-shrink-0">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${tab === t.key ? 'text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
              style={tab === t.key ? { backgroundColor: 'rgb(12,28,53)' } : undefined}>
              {t.icon}
              {t.label}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${tab === t.key ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>{counts[t.key]}</span>
            </button>
          ))}
        </div>

        {/* Document list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-slate-400 text-sm">
              <EmptyIcon />
              <p className="mt-3">No documents found</p>
            </div>
          )}
          <div className="divide-y divide-slate-50">
            {filtered.map(doc => {
              const isLoading = loading === doc.id
              const isDlLoading = loading === `dl-${doc.id}`
              return (
                <div key={doc.id} className="px-4 py-3.5 hover:bg-slate-50 transition-colors group">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-0.5">
                      <DocTypeIcon type={doc.type} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span className="font-mono text-xs font-semibold text-slate-800">{doc.number}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${TYPE_COLORS[doc.type]}`}>{TYPE_LABELS[doc.type]}</span>
                        {doc.statusBadge && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${doc.statusColor}`}>{doc.statusBadge}</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-600 truncate">{doc.customer}</div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-[10px] text-slate-400">{doc.date}</span>
                        {doc.amount && <span className="text-[10px] font-semibold text-slate-700 tabular">{doc.amount}</span>}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <button onClick={() => handleView(doc)} disabled={isLoading} title="View in browser"
                        className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors">
                        {isLoading ? <SpinnerIcon /> : <EyeIcon />} View
                      </button>
                      <button onClick={() => handleDownload(doc)} disabled={isDlLoading} title="Download PDF"
                        className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors">
                        {isDlLoading ? <SpinnerIcon /> : <DownloadIcon />}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-100 flex-shrink-0 bg-slate-50">
          <p className="text-[10px] text-slate-400 text-center">Click "View" to preview · "↓" to download PDF</p>
        </div>
      </div>

      {/* Inline PDF Viewer */}
      {viewer && (
        <PDFViewer
          url={viewer.url}
          title={viewer.title}
          onClose={() => setViewer(null)}
          onDownload={() => { viewer.downloadFn(); toast.success('Downloaded!') }}
        />
      )}
    </>
  )
}

function DocTypeIcon({ type }: { type: Exclude<DocType, 'all'> }) {
  const base = 'size-8 rounded-lg flex items-center justify-center flex-shrink-0'
  if (type === 'invoice') return <div className={`${base} bg-blue-50`}><InvoiceIcon className="size-4 text-blue-600" /></div>
  if (type === 'receipt') return <div className={`${base} bg-emerald-50`}><ReceiptIcon className="size-4 text-emerald-600" /></div>
  if (type === 'packing-list') return <div className={`${base} bg-violet-50`}><ListIcon className="size-4 text-violet-600" /></div>
  return <div className={`${base} bg-amber-50`}><TagIcon className="size-4 text-amber-600" /></div>
}

const XIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
const FolderIcon = () => <svg className="size-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
const GridIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
const InvoiceIcon = ({ className }: { className?: string }) => <svg className={className || 'size-3.5'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
const ReceiptIcon = ({ className }: { className?: string }) => <svg className={className || 'size-3.5'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
const ListIcon = ({ className }: { className?: string }) => <svg className={className || 'size-3.5'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
const TagIcon = ({ className }: { className?: string }) => <svg className={className || 'size-3.5'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>
const SearchIcon = ({ className }: { className?: string }) => <svg className={className || 'size-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
const EyeIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
const DownloadIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
const SpinnerIcon = () => <svg className="size-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
const EmptyIcon = () => <svg className="size-10 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
