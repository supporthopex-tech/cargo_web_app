import { useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { allocatedQuantity, availableQuantity, formatPackingQuantity } from '../lib/packing'
import { shipmentFinancialSummary } from '../lib/accounting'
import { formatAmount, STATUS_LABELS, STATUS_ORDER } from '../types'
import type { PackingAllocation, PackingList, Shipment, ShipmentStatus } from '../types'
import { StatusBadge } from '../components/StatusBadge'
import type { Screen } from '../App'

interface Props {
  onNavigate: (screen: Screen, id?: string) => void
  /** Pre-fills the search box — e.g. when arriving here from the top-bar search or a Dashboard quick action. */
  initialQuery?: string
  /** Pre-selects a status filter — e.g. when arriving here from a Dashboard "Shipments by Status" tile. */
  initialStatus?: ShipmentStatus | ''
}

// Independent Shipments module: the full, filterable list of every shipment.
// Lives on its own nav item / screen — Dashboard only links here, it no longer
// embeds this table itself (see App.tsx's `shipments` screen + NAV_ITEMS).
export default function Shipments({ onNavigate, initialQuery, initialStatus }: Props) {
  const { shipments, customers, packingAllocations, packingLists, getExtraChargesForShipment } = useAppStore()
  const [searchQuery, setSearchQuery] = useState(initialQuery ?? '')
  const [statusFilter, setStatusFilter] = useState<ShipmentStatus | ''>(initialStatus ?? '')
  const [methodFilter, setMethodFilter] = useState('')
  const [customerFilter, setCustomerFilter] = useState('')
  const [dateFilter, setDateFilter] = useState('')

  const filtered = useMemo(() => {
    let list = shipments
    if (searchQuery) {
      const lq = searchQuery.toLowerCase()
      const matchedCustomers = customers.filter(c =>
        c.company.toLowerCase().includes(lq) || c.name.toLowerCase().includes(lq)
      ).map(c => c.id)
      list = list.filter(s =>
        s.trackingNumber.toLowerCase().includes(lq) ||
        s.description.toLowerCase().includes(lq) ||
        s.destinationCity.toLowerCase().includes(lq) ||
        matchedCustomers.includes(s.customerId)
      )
    }
    if (statusFilter) list = list.filter(s => s.status === statusFilter)
    if (methodFilter) list = list.filter(s => s.shipmentType === methodFilter)
    if (customerFilter) list = list.filter(s => s.customerId === customerFilter)
    if (dateFilter) list = list.filter(s => s.createdAt.slice(0, 10) === dateFilter)
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [shipments, customers, searchQuery, statusFilter, methodFilter, customerFilter, dateFilter])

  const getCustomer = (id: string) => customers.find(c => c.id === id)
  const financialFor = (shipment: Shipment) => shipmentFinancialSummary(
    shipment.invoiceAmount ?? shipment.totalAmount,
    shipment.amountPaid,
    getExtraChargesForShipment(shipment.id),
  )

  return (
    <div className="app-page space-y-4 sm:space-y-6">
      <div className="premium-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">All Shipments</h2>
            <p className="text-xs text-slate-400 mt-0.5">{filtered.length} shipments</p>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as ShipmentStatus | '')} className="min-h-11 rounded-lg border border-slate-200 bg-white px-2 text-sm focus:outline-none">
              <option value="">All Statuses</option>
              {STATUS_ORDER.map(status => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
            </select>
            <select value={methodFilter} onChange={e => setMethodFilter(e.target.value)} className="min-h-11 rounded-lg border border-slate-200 bg-white px-2 text-sm focus:outline-none"><option value="">All Shipping Methods</option>{[...new Set(shipments.map(shipment => shipment.shipmentType))].sort().map(method => <option key={method} value={method}>{method}</option>)}</select>
            <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} className="min-h-11 rounded-lg border border-slate-200 bg-white px-2 text-sm focus:outline-none"><option value="">All Customers</option>{[...customers].sort((a, b) => (a.company || a.name).localeCompare(b.company || b.name)).map(customer => <option key={customer.id} value={customer.id}>{customer.company || customer.name}</option>)}</select>
            <input aria-label="Shipment date" type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} className="min-h-11 rounded-lg border border-slate-200 bg-white px-2 text-sm focus:outline-none" />
            <div className="relative min-w-0">
              <SearchIconSm className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-slate-400" />
              <input id="main-search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search tracking # or customer…" className="min-h-11 w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 text-base placeholder:text-slate-400 focus:outline-none focus:ring-2 sm:w-64 sm:text-sm" />
            </div>
          </div>
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Tracking #</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Shipping / Cargo</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">KG / CBM</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">USD Base</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Invoice</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Balance</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-14 text-center"><div className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-navy-50 text-navy-500"><BoxEmptyIcon /></div><div className="mt-3 text-sm font-semibold text-slate-700">No shipments found</div><div className="mt-1 text-xs text-slate-400">Create a shipment or adjust your search filters.</div></td></tr>
              )}
              {filtered.map(s => {
                const customer = getCustomer(s.customerId)
                const financial = financialFor(s)
                const balance = financial.balance
                const packing = packingProgress(s, packingAllocations, packingLists)
                return (
                  <tr key={s.id} className="hover:bg-slate-50 transition-colors cursor-pointer group" onClick={() => onNavigate('shipment-detail', s.id)}>
                    <td className="px-5 py-3.5"><span className="font-mono text-xs font-medium text-navy-700">{s.trackingNumber}</span></td>
                    <td className="px-4 py-3.5">
                      <div className="font-medium text-slate-800 truncate max-w-[160px]">{customer?.company || 'Unknown'}</div>
                    </td>
                    <td className="px-4 py-3.5"><div className="text-slate-700 text-xs font-semibold">{s.shipmentType}</div><div className="text-slate-400 text-xs">{s.items.length || 1} item type(s) / {s.pcs} units</div>{packing && <PackingBadge packing={packing} />}</td>
                    <td className="px-4 py-3.5 text-right tabular">
                      <div className="text-slate-700 text-xs">{s.weightKg.toLocaleString()} kg</div>
                      <div className="text-slate-400 text-xs">{s.volumeCbm} cbm</div>
                    </td>
                    <td className="px-4 py-3.5 text-right tabular"><span className="font-semibold text-slate-800">{s.baseAmountUsd == null ? '—' : formatAmount(s.baseAmountUsd, 'USD')}</span></td>
                    <td className="px-4 py-3.5 text-right tabular"><span className="font-semibold text-slate-800">{formatAmount(financial.totalDue, s.invoiceCurrency ?? s.currency)}</span></td>
                    <td className="px-4 py-3.5 text-right tabular">
                      {balance > 0 ? <span className="text-red-600 font-semibold">{formatAmount(balance, s.invoiceCurrency ?? s.currency)}</span> : <span className="text-emerald-600 font-semibold">Paid</span>}
                    </td>
                    <td className="px-4 py-3.5 text-center"><StatusBadge status={s.status} /></td>
                    <td className="px-4 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors" title="View Detail" onClick={e => { e.stopPropagation(); onNavigate('shipment-detail', s.id) }}><EyeIcon /></button>
                        <button className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors" title="Record Payment" onClick={e => { e.stopPropagation(); onNavigate('payments') }}><ReceiptIcon /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-100 md:hidden">
          {filtered.length === 0 && <div className="px-4 py-10 text-center"><div className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-navy-50 text-navy-500"><BoxEmptyIcon /></div><div className="mt-3 text-sm font-semibold text-slate-700">No shipments found</div><div className="mt-1 text-xs text-slate-400">Create a shipment or adjust your filters.</div></div>}
          {filtered.map(shipment => {
            const customer = getCustomer(shipment.customerId)
            const financial = financialFor(shipment)
            const balance = financial.balance
            const packing = packingProgress(shipment, packingAllocations, packingLists)
            return (
              <button key={shipment.id} onClick={() => onNavigate('shipment-detail', shipment.id)} className="block min-h-11 w-full p-4 text-left hover:bg-slate-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><div className="font-mono text-sm font-bold text-navy-700">{shipment.trackingNumber}</div><div className="mt-1 truncate font-semibold text-slate-900">{customer?.company || customer?.name || 'Unknown'}</div></div>
                  <StatusBadge status={shipment.status} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div><div className="text-slate-400">Cargo</div><div className="mt-0.5 font-semibold text-slate-700">{shipment.shipmentType}</div><div className="text-slate-500">{shipment.weightKg} KG · {shipment.volumeCbm} CBM</div>{packing && <PackingBadge packing={packing} />}</div>
                  <div className="text-right"><div className="text-slate-400">Invoice</div><div className="mt-0.5 font-bold text-slate-800">{formatAmount(financial.totalDue, shipment.invoiceCurrency ?? shipment.currency)}</div><div className={balance > 0 ? 'text-red-600' : 'text-emerald-600'}>{balance > 0 ? `Balance ${formatAmount(balance, shipment.invoiceCurrency ?? shipment.currency)}` : 'Paid'}</div></div>
                </div>
                <div className="mt-3 text-right text-xs font-bold text-cargo-600">View Shipment →</div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface PackingProgress { status: 'full' | 'partial' | 'none'; packedLabel: string }

// Aggregates each item's allocated (packed) vs available (remaining) quantity, grouped by
// unit since a shipment's items can mix units (pcs, cartons, kg, ...). Read-only derivation
// from existing packing_allocations / packing_lists data — no schema change.
function packingProgress(shipment: Shipment, allocations: PackingAllocation[], packingLists: PackingList[]): PackingProgress | null {
  if (!shipment.items.length) return null
  const totals = new Map<string, { packed: number; remaining: number }>()
  let hasQuantity = false
  shipment.items.forEach(item => {
    if (item.quantity <= 0) return
    hasQuantity = true
    const entry = totals.get(item.unit) || { packed: 0, remaining: 0 }
    entry.packed += allocatedQuantity(item.id, allocations, packingLists)
    entry.remaining += availableQuantity(item, allocations, packingLists)
    totals.set(item.unit, entry)
  })
  if (!hasQuantity) return null
  const packedTotal = [...totals.values()].reduce((sum, t) => sum + t.packed, 0)
  const remainingTotal = [...totals.values()].reduce((sum, t) => sum + t.remaining, 0)
  const status: PackingProgress['status'] = packedTotal <= 0 ? 'none' : remainingTotal <= 0 ? 'full' : 'partial'
  const packedLabel = [...totals.entries()].map(([unit, t]) => `${formatPackingQuantity(t.packed)} ${unit}`).join(' · ')
  return { status, packedLabel }
}

function PackingBadge({ packing }: { packing: PackingProgress }) {
  if (packing.status === 'none') return <div className="mt-0.5 text-[10px] font-semibold text-slate-400">Not packed yet</div>
  const tone = packing.status === 'full' ? 'text-emerald-600' : 'text-amber-600'
  const label = packing.status === 'full' ? 'Fully packed' : 'Packed'
  return <div className={`mt-0.5 text-[10px] font-semibold ${tone}`}>{label}: {packing.packedLabel}</div>
}

const SearchIconSm = ({ className = 'size-4' }: { className?: string }) => <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
const ReceiptIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
const EyeIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
const BoxEmptyIcon = () => <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21 8l-9 5-9-5m9 5v9M4.5 5.5L12 2l7.5 3.5v12L12 22l-7.5-4.5v-12z" /></svg>
