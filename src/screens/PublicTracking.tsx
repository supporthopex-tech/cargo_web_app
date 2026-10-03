import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppStore } from '../store/useAppStore'
import { shipmentStatusLabel, STATUS_ORDER } from '../types'
import type { ShipmentStatus } from '../types'
import type { Screen } from '../App'
import { timelineState } from '../lib/statusLifecycle'

interface Props { shipmentId?: string; onNavigate?: (screen: Screen, id?: string) => void }
interface PublicEvent { status: ShipmentStatus; location?: string; customsType?: 'AIRPORT' | 'SEA_PORT'; customsLocation?: string; time: string; description?: string }
interface PublicResult { shipmentNumber: string; status: ShipmentStatus; isOnHold: boolean; origin: string; destination: string; currentLocation?: string; receiver: string; weightKg: number; pcs: number; lastUpdate: string; history: PublicEvent[] }

function mapPublicResult(value: any): PublicResult | null {
  if (!value?.shipmentNumber || !STATUS_ORDER.includes(value.status)) return null
  return {
    shipmentNumber: String(value.shipmentNumber), status: value.status, isOnHold: Boolean(value.isOnHold),
    origin: String(value.origin ?? ''), destination: String(value.destination ?? ''), currentLocation: value.currentLocation ?? undefined,
    receiver: String(value.receiver ?? '—'), weightKg: Number(value.weightKg ?? 0), pcs: Number(value.pcs ?? 0), lastUpdate: String(value.lastUpdate ?? ''),
    history: Array.isArray(value.history) ? value.history.filter((event: any) => STATUS_ORDER.includes(event.status)).map((event: any) => ({ status: event.status, location: event.location ?? undefined, customsType: event.customsType ?? undefined, customsLocation: event.customsLocation ?? undefined, time: String(event.time), description: event.description ?? undefined })) : [],
  }
}

export default function PublicTracking({ shipmentId, onNavigate }: Props) {
  const shipments = useAppStore(state => state.shipments)
  const settings = useAppStore(state => state.settings)
  const phoneDigits = settings.phone.replace(/[^+\d]/g, '')
  const whatsappDigits = phoneDigits.replace(/^\+/, '')
  const linkedTracking = shipmentId ? shipments.find(shipment => shipment.id === shipmentId)?.trackingNumber : undefined
  const urlParams = new URLSearchParams(window.location.search)
  const urlTracking = urlParams.get('tracking') ?? ''
  const verifyingReceipt = urlParams.get('receipt') ?? ''
  const verifyingInvoice = urlParams.get('invoice') ?? ''
  const initialTracking = linkedTracking || urlTracking
  const [query, setQuery] = useState(initialTracking)
  const [found, setFound] = useState<PublicResult | null>(null)
  const [searched, setSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function search(trackingNumber: string) {
    const normalized = trackingNumber.trim()
    if (!normalized) return
    setLoading(true); setError(''); setSearched(true)
    const result = await supabase.rpc('track_shipment', { p_tracking_number: normalized })
    if (result.error) { setFound(null); setError('Tracking is temporarily unavailable. Please try again.'); setLoading(false); return }
    setFound(mapPublicResult(result.data)); setLoading(false)
  }

  useEffect(() => { if (initialTracking) { setQuery(initialTracking); void search(initialTracking) } }, [initialTracking])

  return <div className="min-h-screen bg-slate-100">
    <header className="border-b border-white/10 bg-[#0c0f38]"><div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4"><div className="flex items-center gap-3"><div className="flex size-9 items-center justify-center rounded-xl bg-cargo-500 text-white"><CargoIcon /></div><div><div className="text-sm font-bold tracking-wide text-white">HOPEX EXPRESS CARGO</div><div className="text-[10px] text-blue-200/70">Secure Shipment Tracking</div></div></div>{onNavigate && <button onClick={() => onNavigate('dashboard')} className="min-h-11 rounded-lg px-3 text-xs font-semibold text-blue-100 hover:bg-white/10">Staff Portal</button>}</div></header>
    <section className="bg-[#0c1c35] px-4 py-10"><div className="mx-auto max-w-2xl"><div className="text-center"><div className="text-xs font-bold uppercase tracking-[0.18em] text-orange-400">Dubai to Tanzania</div><h1 className="mt-2 text-2xl font-bold text-white">Track Your Shipment</h1><p className="mt-2 text-sm text-slate-300">Enter the tracking number shown on your cargo receipt.</p></div><form onSubmit={event => { event.preventDefault(); void search(query) }} className="mt-6 grid gap-2 sm:grid-cols-[1fr_auto]"><input value={query} onChange={event => { setQuery(event.target.value); setSearched(false); setFound(null); setError('') }} placeholder="HOPEX-260804-0001" className="min-h-12 rounded-xl border border-white/10 bg-[#0c0f38] px-4 font-mono text-base text-white outline-none ring-orange-400 placeholder:text-slate-500 focus:ring-2" /><button disabled={loading || !query.trim()} className="min-h-12 rounded-xl bg-orange-500 px-7 text-sm font-bold text-white disabled:opacity-50">{loading ? 'Tracking…' : 'Track Cargo'}</button></form></div></section>
    <main className="mx-auto max-w-4xl px-4 py-8">
      {error && <Message title="Tracking unavailable" text={error} danger />}
      {searched && !loading && !error && !found && <Message title="Shipment not found" text={`No shipment matches “${query.trim()}”. Check the tracking number and try again.`} danger />}
      {!searched && !found && <Message title="Your cargo journey, clearly shown" text="Only customer-safe milestones are displayed. Internal operational notes remain private." />}
      {found && <div className="space-y-5">
        {(verifyingReceipt || verifyingInvoice) && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-sm font-semibold text-emerald-800">
          {verifyingReceipt ? `Verifying Receipt #${verifyingReceipt}` : `Verifying Invoice #${verifyingInvoice}`}
        </div>}
        <section className="premium-card p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="font-mono text-lg font-bold text-navy-900">{found.shipmentNumber}</div><div className="mt-1 text-sm text-slate-500">Receiver: {found.receiver}</div></div><div className={`rounded-full px-3 py-1.5 text-xs font-bold ${found.isOnHold ? 'bg-red-100 text-red-700' : found.status === 'DELIVERED' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{found.isOnHold ? 'On Hold · ' : ''}{shipmentStatusLabel(found.status)}</div></div>
          {found.isOnHold && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">This shipment is temporarily on hold. Its lifecycle stage has not been replaced.</div>}
          <div className="mt-5 grid gap-3 rounded-xl bg-[#0c1c35] p-4 text-center text-white sm:grid-cols-[1fr_auto_1fr]"><div><div className="text-[10px] uppercase text-slate-400">Origin</div><div className="mt-1 text-sm font-semibold">{found.origin}</div></div><div className="self-center text-orange-400">→</div><div><div className="text-[10px] uppercase text-slate-400">Destination</div><div className="mt-1 text-sm font-semibold">{found.destination}</div></div></div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="Weight" value={`${found.weightKg.toLocaleString()} kg`} /><Metric label="Pieces" value={String(found.pcs)} /><Metric label="Current Location" value={found.currentLocation || 'Updating'} /><Metric label="Last Update" value={dateLabel(found.lastUpdate)} /></div>
        </section>
        <section className="premium-card p-5 sm:p-6"><h2 className="font-bold text-slate-900">Shipment Lifecycle</h2><div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-7">{STATUS_ORDER.map(status => { const state = timelineState(found.status, status); return <div key={status} className={`rounded-xl border p-3 text-center ${state === 'current' ? 'border-orange-400 bg-orange-50' : state === 'complete' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}><div className={`mx-auto size-3 rounded-full ${state === 'current' ? 'bg-orange-500' : state === 'complete' ? 'bg-emerald-500' : 'bg-slate-200'}`} /><div className="mt-2 text-[10px] font-bold leading-tight text-slate-700">{shipmentStatusLabel(status)}</div></div> })}</div></section>
        <section className="premium-card p-5 sm:p-6"><h2 className="font-bold text-slate-900">Tracking History</h2><div className="mt-4 space-y-0">{[...found.history].reverse().map((event, index) => <div key={`${event.status}-${event.time}-${index}`} className="flex gap-3"><div className="flex flex-col items-center"><div className={`mt-1 size-3 rounded-full ${index === 0 ? 'bg-orange-500' : 'bg-slate-300'}`} />{index < found.history.length - 1 && <div className="my-1 w-px flex-1 bg-slate-200" />}</div><div className="flex-1 pb-5"><div className="text-sm font-bold text-slate-800">{shipmentStatusLabel(event.status)}{event.customsType ? ` · ${event.customsType === 'AIRPORT' ? 'Airport' : 'Sea Port'}` : ''}</div>{event.location && <div className="mt-1 text-xs text-slate-500">{event.location}</div>}{event.description && <div className="mt-1 text-xs text-slate-600">{event.description}</div>}<div className="mt-1 text-[10px] text-slate-400">{dateLabel(event.time)}</div></div></div>)}{!found.history.length && <p className="py-8 text-center text-sm text-slate-400">No public milestones have been published yet.</p>}</div></section>
      </div>}
      {settings.phone && <p className="mt-8 text-center text-sm text-slate-500">Need help? <a href={`tel:${phoneDigits}`} className="font-semibold text-orange-600 hover:underline">Call {settings.phone}</a> · <a href={`https://wa.me/${whatsappDigits}`} target="_blank" rel="noreferrer" className="font-semibold text-orange-600 hover:underline">WhatsApp us</a></p>}
    </main>
  </div>
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div><div className="mt-1 break-words text-sm font-bold text-slate-800">{value}</div></div> }
function Message({ title, text, danger = false }: { title: string; text: string; danger?: boolean }) { return <div className={`rounded-2xl border p-8 text-center ${danger ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}><h2 className={`font-bold ${danger ? 'text-red-900' : 'text-slate-800'}`}>{title}</h2><p className={`mx-auto mt-2 max-w-xl text-sm ${danger ? 'text-red-700' : 'text-slate-500'}`}>{text}</p></div> }
function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString() }
function CargoIcon() { return <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg> }
