import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useRatesStore } from '../store/useRatesStore'
import { canAccess, useAuthStore } from '../store/useAuthStore'
import { findApplicableExchangeRate } from '../lib/exchangeRateService'
import { shipmentFinancialSummary } from '../lib/accounting'
import { STATUS_LABELS, STATUS_ORDER } from '../types'
import type { ShipmentStatus } from '../types'
import type { Screen } from '../App'

interface Props {
  onNavigate: (screen: Screen, id?: string) => void
  onViewShipmentsByStatus?: (status: ShipmentStatus) => void
}

export default function Dashboard({ onNavigate, onViewShipmentsByStatus }: Props) {
  const { shipments, settings, extraCharges } = useAppStore()
  const exchangeRates = useRatesStore(state => state.exchangeRates)
  const currentUser = useAuthStore(state => state.currentUser)
  const today = new Date().toISOString().slice(0, 10)

  const kpis = useMemo(() => {
    const receivedToday = shipments.filter(s => s.createdAt === today).length
    const waitingDispatch = shipments.filter(s => ['RECEIVED', 'PACKED'].includes(s.status)).length
    const arrived = shipments.filter(s => s.status === 'ARRIVED').length
    const outstanding = shipments.filter(shipment => shipmentFinancialSummary(
      shipment.invoiceAmount ?? shipment.totalAmount,
      shipment.amountPaid,
      extraCharges.filter(charge => charge.shipmentId === shipment.id && charge.status === 'ACTIVE'),
    ).balance > 0 && shipment.status !== 'DELIVERED')
    const byStatus = Object.fromEntries(STATUS_ORDER.map(status => [status, shipments.filter(shipment => shipment.status === status).length])) as Record<ShipmentStatus, number>
    return { receivedToday, waitingDispatch, arrived, outstandingCount: outstanding.length, byStatus }
  }, [shipments, extraCharges, today])

  const todayFx = exchangeRates.find(rate => rate.rateDate === today)
  const applicableFx = findApplicableExchangeRate(exchangeRates, today, settings.exchangeRatePolicy)

  return (
    <div className="app-page space-y-4 sm:space-y-6">
      {/* Quick actions */}
      <div>
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Quick Actions</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <QuickAction icon={<PlusIcon />} label="Add Shipment" sub="Create new cargo entry" accent onClick={() => onNavigate('create-shipment')} />
          <QuickAction icon={<SearchIconSm />} label="Search Shipment" sub="Find by tracking # or customer" onClick={() => onNavigate('shipments')} />
          <QuickAction icon={<ReceiptIcon />} label="Record Payment" sub="Log payment against shipment" onClick={() => onNavigate('payments')} />
          <QuickAction icon={<ListIcon />} label="Create Packing List" sub="Bundle shipments for dispatch" onClick={() => onNavigate('packing-list')} />
        </div>
      </div>

      <div className={`rounded-xl border p-4 flex flex-wrap items-center gap-4 ${todayFx ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
        <div className="min-w-0 flex-1 basis-60">
          <div className="text-xs font-bold uppercase tracking-wide">Today's Exchange Rates</div>
          {todayFx ? <div className="text-sm mt-1">USD/TZS configured ✓ · USD/AED configured ✓</div> : applicableFx?.isCarryForward ? <div className="text-sm mt-1">Today's rates are missing. Using approved rates from {applicableFx.rate.rateDate}.</div> : <div className="text-sm mt-1 font-semibold">Today's exchange rates have not been configured.</div>}
        </div>
        {canAccess(currentUser?.role, 'exchange_rates.manage') && <button onClick={() => onNavigate('settings')} className="secondary-button">Update Rates</button>}
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard value={kpis.receivedToday} label="Received Today" trend={today} color="text-blue-600" bg="bg-blue-50" icon={<InboxIcon />} />
        <KpiCard value={kpis.waitingDispatch} label="Awaiting Dispatch" trend="Needs attention" color="text-amber-600" bg="bg-amber-50" icon={<ClockIcon />} />
        <KpiCard value={kpis.arrived} label="Arrived — Pending" trend="Ready / At port" color="text-emerald-600" bg="bg-emerald-50" icon={<AnchorIcon />} />
        <KpiCard
          value={kpis.outstandingCount}
          label="Outstanding Invoices"
          trend="Balances stay in each invoice currency"
          color="text-red-600" bg="bg-red-50" icon={<AlertIcon />}
        />
      </div>

      {/* Shipment lifecycle counts — each tile opens the independent Shipments module pre-filtered to that status */}
      <div>
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Shipments by Status</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7" aria-label="Shipment lifecycle counts">
          {STATUS_ORDER.map(status => (
            <button key={status} type="button" onClick={() => onViewShipmentsByStatus ? onViewShipmentsByStatus(status) : onNavigate('shipments')} className="rounded-xl border border-slate-200 bg-white p-3 text-left transition-colors hover:border-slate-300 hover:bg-slate-50">
              <div className="text-2xl font-bold text-slate-900">{kpis.byStatus[status]}</div>
              <div className="mt-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">{STATUS_LABELS[status]}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function QuickAction({ icon, label, sub, accent, onClick }: { icon: React.ReactNode; label: string; sub: string; accent?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`premium-card premium-card-hover flex items-center gap-3 p-4 text-left active:translate-y-0 ${accent ? 'border-transparent text-white' : ''}`}
      style={accent ? { background: 'linear-gradient(135deg, #024fa1, #0a84d3)', boxShadow: '0 12px 28px rgba(2,79,161,.22)' } : undefined}>
      <div className={`rounded-xl p-2.5 ${accent ? 'bg-white/15 text-white' : 'bg-navy-50 text-navy-600'}`}>{icon}</div>
      <div>
        <div className={`font-semibold text-sm ${accent ? 'text-white' : 'text-slate-800'}`}>{label}</div>
        <div className={`mt-0.5 text-xs ${accent ? 'text-white/75' : 'text-slate-400'}`}>{sub}</div>
      </div>
    </button>
  )
}

function KpiCard({ value, label, trend, color, bg, icon }: { value: string | number; label: string; trend: string; color: string; bg: string; icon: React.ReactNode }) {
  return (
    <div className="metric-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className={`text-2xl font-bold tabular ${color}`}>{value}</div>
          <div className="text-sm font-medium text-slate-700 mt-0.5">{label}</div>
          <div className="text-xs text-slate-400 mt-1">{trend}</div>
        </div>
        <div className={`p-2 rounded-lg ${bg} ${color}`}>{icon}</div>
      </div>
    </div>
  )
}

const PlusIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
const SearchIconSm = ({ className = 'size-4' }: { className?: string }) => <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
const ReceiptIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
const ListIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
const InboxIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
const ClockIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
const AnchorIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
const AlertIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
