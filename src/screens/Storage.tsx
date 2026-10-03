import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import type { Screen } from '../App'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore, canAccess } from '../store/useAuthStore'
import PageHeader from '../components/PageHeader'
import Modal from '../components/Modal'
import { StatusBadge } from '../components/StatusBadge'
import { formatPackingQuantity } from '../lib/packing'
import { inventoryPackingStatus, inventoryPackingStatusLabel } from '../lib/inventory'
import type { InventoryFilters, InventoryItemDetail, InventoryPackingStatus, InventoryRow } from '../types'

interface Props { onNavigate: (screen: Screen, id?: string) => void }

const PAGE_SIZE = 50

export default function Storage({ onNavigate }: Props) {
  const { customers, searchInventory, getInventoryItemDetail, recordItemReturn } = useAppStore()
  const currentUser = useAuthStore(s => s.currentUser)
  const canManageReturns = canAccess(currentUser?.role, 'inventory')

  const [search, setSearch] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [packingStatus, setPackingStatus] = useState<InventoryPackingStatus | ''>('')
  const [returnedOnly, setReturnedOnly] = useState(false)
  const [page, setPage] = useState(0)

  const [rows, setRows] = useState<InventoryRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)

  const [detailItemId, setDetailItemId] = useState<string | null>(null)
  const [detail, setDetail] = useState<InventoryItemDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [returnModalItem, setReturnModalItem] = useState<InventoryRow | null>(null)
  const [returnQuantity, setReturnQuantity] = useState('')
  const [returnReason, setReturnReason] = useState('')
  const [returnSubmitting, setReturnSubmitting] = useState(false)

  const filters: InventoryFilters = useMemo(() => ({
    search: search.trim() || undefined,
    customerId: customerId || undefined,
    trackingNumber: trackingNumber.trim() || undefined,
    packingStatus: packingStatus || undefined,
    returnedOnly: returnedOnly || undefined,
  }), [search, customerId, trackingNumber, packingStatus, returnedOnly])

  // Reset to page 0 whenever a filter changes.
  useEffect(() => { setPage(0) }, [search, customerId, trackingNumber, packingStatus, returnedOnly])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const handle = window.setTimeout(() => {
      searchInventory(filters, PAGE_SIZE, page * PAGE_SIZE)
        .then(result => {
          if (cancelled) return
          setRows(result.rows)
          setTotalCount(result.totalCount)
        })
        .catch(error => {
          if (cancelled) return
          toast.error(error instanceof Error ? error.message : 'Failed to load inventory.')
        })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(handle) }
  }, [filters, page, reloadToken, searchInventory])

  function refresh() { setReloadToken(t => t + 1) }

  async function openDetail(row: InventoryRow) {
    setDetailItemId(row.shipmentItemId)
    setDetail(null)
    setDetailLoading(true)
    try {
      const d = await getInventoryItemDetail(row.shipmentItemId)
      setDetail(d)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load item detail.')
      setDetailItemId(null)
    } finally {
      setDetailLoading(false)
    }
  }

  function openReturnModal(row: InventoryRow) {
    setReturnModalItem(row)
    setReturnQuantity('')
    setReturnReason('')
  }

  async function submitReturn() {
    if (!returnModalItem) return
    const amount = Number(returnQuantity)
    if (!amount || amount <= 0) { toast.error('Enter a positive quantity.'); return }
    if (amount > returnModalItem.storageQuantity) {
      toast.error(`Only ${formatPackingQuantity(returnModalItem.storageQuantity)} ${returnModalItem.unit} is currently in storage.`)
      return
    }
    setReturnSubmitting(true)
    try {
      await recordItemReturn(returnModalItem.shipmentItemId, amount, returnReason)
      toast.success('Return recorded.')
      setReturnModalItem(null)
      refresh()
      if (detailItemId === returnModalItem.shipmentItemId) {
        const d = await getInventoryItemDetail(returnModalItem.shipmentItemId)
        setDetail(d)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to record return.')
    } finally {
      setReturnSubmitting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const rangeStart = totalCount === 0 ? 0 : page * PAGE_SIZE + 1
  const rangeEnd = Math.min(totalCount, (page + 1) * PAGE_SIZE)

  return (
    <div className="app-page">
      <PageHeader
        title="Storage"
        description={loading ? 'Loading inventory…' : `${totalCount} item${totalCount === 1 ? '' : 's'} in the warehouse ledger`}
      />

      {/* Filters */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative min-w-0 lg:col-span-2">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search item, description, tracking, customer…" className="form-input pl-8" />
        </div>
        <select value={customerId} onChange={e => setCustomerId(e.target.value)} className="form-input">
          <option value="">All Customers</option>
          {customers.map(c => <option key={c.id} value={c.id}>{c.company || c.name}</option>)}
        </select>
        <input value={trackingNumber} onChange={e => setTrackingNumber(e.target.value)} placeholder="Tracking number" className="form-input" />
        <select value={packingStatus} onChange={e => setPackingStatus(e.target.value as InventoryPackingStatus | '')} className="form-input">
          <option value="">Any Packing Status</option>
          <option value="NOT_PACKED">Not Packed</option>
          <option value="PARTIALLY_PACKED">Partially Packed</option>
          <option value="FULLY_PACKED">Fully Packed</option>
        </select>
      </div>
      <label className="mb-5 -mt-2 flex items-center gap-2 text-xs text-slate-500">
        <input type="checkbox" checked={returnedOnly} onChange={e => setReturnedOnly(e.target.checked)} className="size-3.5 rounded border-slate-300" />
        Show only items with a recorded return
      </label>

      {/* Table */}
      <div className="data-surface">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Shipment</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Item</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Total</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Packed</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Remaining</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Returned</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">In Storage</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Last Updated</th>
                <th className="px-4 py-3 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {!loading && rows.length === 0 && (
                <tr><td colSpan={11} className="text-center py-12 text-slate-400 text-sm">No inventory matches these filters.</td></tr>
              )}
              {rows.map(row => {
                const status = inventoryPackingStatus(row.totalQuantity, row.packedQuantity)
                const remaining = Math.max(0, row.totalQuantity - row.packedQuantity)
                return (
                  <tr key={row.shipmentItemId} className="cursor-pointer hover:bg-slate-50 transition-colors" onClick={() => openDetail(row)}>
                    <td className="px-5 py-3.5 text-slate-700">{row.customerName}</td>
                    <td className="px-4 py-3.5">
                      <button onClick={e => { e.stopPropagation(); onNavigate('shipment-detail', row.shipmentId) }} className="font-mono text-xs font-semibold text-navy-700 hover:underline">
                        {row.trackingNumber}
                      </button>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-medium text-slate-800">{row.description}</div>
                      {row.itemCode && <div className="text-xs text-slate-400 font-mono">{row.itemCode}</div>}
                    </td>
                    <td className="px-4 py-3.5 text-right text-slate-600">{formatPackingQuantity(row.totalQuantity)} {row.unit}</td>
                    <td className="px-4 py-3.5 text-right text-slate-600">{formatPackingQuantity(row.packedQuantity)}</td>
                    <td className="px-4 py-3.5 text-right text-slate-600">{formatPackingQuantity(remaining)}</td>
                    <td className="px-4 py-3.5 text-right text-slate-600">{row.returnedQuantity > 0 ? formatPackingQuantity(row.returnedQuantity) : '—'}</td>
                    <td className="px-4 py-3.5 text-right font-semibold text-slate-800">{formatPackingQuantity(row.storageQuantity)}</td>
                    <td className="px-4 py-3.5"><PackingStatusBadge status={status} /></td>
                    <td className="px-4 py-3.5 text-xs text-slate-400">{row.lastUpdated ? new Date(row.lastUpdated).toLocaleDateString() : '—'}</td>
                    <td className="px-4 py-3.5">
                      {canManageReturns && row.storageQuantity > 0 && (
                        <button onClick={e => { e.stopPropagation(); openReturnModal(row) }} className="text-xs font-semibold text-orange-600 hover:underline">Return</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-100 md:hidden">
          {!loading && rows.length === 0 && <p className="px-4 py-10 text-center text-sm text-slate-400">No inventory matches these filters.</p>}
          {rows.map(row => {
            const status = inventoryPackingStatus(row.totalQuantity, row.packedQuantity)
            return (
              <article key={row.shipmentItemId} onClick={() => openDetail(row)} className="mobile-data-card m-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-bold text-slate-900">{row.description}</h2>
                    <p className="mt-0.5 text-xs text-slate-500 font-mono">{row.trackingNumber}</p>
                  </div>
                  <PackingStatusBadge status={status} />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                  <span>{row.customerName}</span>
                  <span className="font-semibold text-slate-800">{formatPackingQuantity(row.storageQuantity)} {row.unit} in storage</span>
                </div>
              </article>
            )
          })}
        </div>
      </div>

      {/* Pagination */}
      {totalCount > 0 && (
        <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
          <span>{rangeStart}–{rangeEnd} of {totalCount}</span>
          <div className="flex items-center gap-2">
            <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} className="secondary-button px-3 py-1.5 disabled:opacity-40">Previous</button>
            <span>Page {page + 1} of {totalPages}</span>
            <button disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)} className="secondary-button px-3 py-1.5 disabled:opacity-40">Next</button>
          </div>
        </div>
      )}

      {/* Item Detail Modal */}
      <Modal open={!!detailItemId} onClose={() => setDetailItemId(null)} title="Item Storage Detail" width="max-w-2xl">
        {detailLoading && <div className="py-10 text-center text-sm text-slate-400">Loading…</div>}
        {!detailLoading && detail && (
          <div className="space-y-4">
            <div>
              <div className="text-xs font-bold tracking-[0.2em] text-orange-600">{detail.itemCode || 'ITEM'}</div>
              <h3 className="mt-1 text-lg font-bold text-slate-900">{detail.description}</h3>
              <p className="text-xs text-slate-500">{detail.customerName} · {detail.trackingNumber} · <StatusBadge status={detail.shipmentStatus} /></p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <QuantityCard label="Total" value={detail.totalQuantity} unit={detail.unit} tone="slate" />
              <QuantityCard label="Packed" value={detail.packedQuantity} unit={detail.unit} tone="amber" />
              <QuantityCard label="Returned" value={detail.returnedQuantity} unit={detail.unit} tone="amber" />
              <QuantityCard label="In Storage" value={detail.storageQuantity} unit={detail.unit} tone="green" />
            </div>
            {detail.boxes.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Boxes Containing This Item</div>
                <div className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                  {detail.boxes.map((b, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div>
                        <span className="font-mono font-semibold text-slate-800">BOX {String(b.boxNumber).padStart(3, '0')}</span>
                        <span className="ml-2 text-xs text-slate-400">{b.packingListNumber} · {b.packingListStatus}</span>
                      </div>
                      <div className="font-semibold text-slate-700">{formatPackingQuantity(b.quantity)} {detail.unit}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {detail.returns.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Return History</div>
                <div className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                  {detail.returns.map((r, i) => (
                    <div key={i} className="px-3 py-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-800">{formatPackingQuantity(r.quantity)} {detail.unit}</span>
                        <span className="text-xs text-slate-400">{new Date(r.returnedAt).toLocaleString()}</span>
                      </div>
                      <div className="text-xs text-slate-500">{r.returnedBy}{r.reason ? ` — ${r.reason}` : ''}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={() => onNavigate('shipment-detail', detail.shipmentId)} className="secondary-button flex-1">View Shipment</button>
              {canManageReturns && detail.storageQuantity > 0 && (
                <button
                  onClick={() => {
                    setDetailItemId(null)
                    openReturnModal({
                      shipmentItemId: detail.shipmentItemId, itemCode: detail.itemCode, description: detail.description,
                      unit: detail.unit, totalQuantity: detail.totalQuantity, packedQuantity: detail.packedQuantity,
                      dispatchedQuantity: detail.dispatchedQuantity, returnedQuantity: detail.returnedQuantity,
                      storageQuantity: detail.storageQuantity, shipmentId: detail.shipmentId, trackingNumber: detail.trackingNumber,
                      shipmentStatus: detail.shipmentStatus, customerId: detail.customerId, customerName: detail.customerName,
                    })
                  }}
                  className="primary-button flex-1"
                >
                  Record Return
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Record Return Modal */}
      <Modal open={!!returnModalItem} onClose={() => setReturnModalItem(null)} title="Record Item Return">
        {returnModalItem && (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="font-semibold text-slate-800">{returnModalItem.description}</div>
              <div className="text-xs text-slate-500">In storage: {formatPackingQuantity(returnModalItem.storageQuantity)} {returnModalItem.unit}</div>
            </div>
            <label className="block">
              <span className="form-label">Quantity Returned</span>
              <input type="number" min="0.001" step="0.001" max={returnModalItem.storageQuantity} value={returnQuantity} onChange={e => setReturnQuantity(e.target.value)} className="form-input" />
            </label>
            <label className="block">
              <span className="form-label">Reason (optional)</span>
              <textarea value={returnReason} onChange={e => setReturnReason(e.target.value)} rows={2} className="form-input resize-none" placeholder="e.g. damaged, customer declined…" />
            </label>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setReturnModalItem(null)} className="secondary-button flex-1">Cancel</button>
              <button onClick={submitReturn} disabled={returnSubmitting} className="primary-button flex-1 disabled:opacity-60">
                {returnSubmitting ? 'Recording…' : 'Record Return'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function QuantityCard({ label, value, unit, tone }: { label: string; value: number; unit: string; tone: 'slate' | 'amber' | 'green' }) {
  const classes = tone === 'green' ? 'bg-emerald-50 text-emerald-800' : tone === 'amber' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-800'
  return <div className={`rounded-xl p-3 ${classes}`}><div className="text-[10px] font-semibold uppercase">{label}</div><div className="mt-1 font-bold">{formatPackingQuantity(value)} <span className="text-xs">{unit}</span></div></div>
}

function PackingStatusBadge({ status }: { status: InventoryPackingStatus }) {
  const styles = status === 'FULLY_PACKED'
    ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
    : status === 'PARTIALLY_PACKED'
      ? 'bg-amber-50 text-amber-700 ring-amber-200'
      : 'bg-slate-100 text-slate-600 ring-slate-200'
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${styles}`}><span className="size-1.5 rounded-full bg-current opacity-80" />{inventoryPackingStatusLabel(status)}</span>
}

const SearchIcon = ({ className }: { className?: string }) => <svg className={className || 'size-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
