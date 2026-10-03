import { useState, useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore } from '../store/useAuthStore'
import { formatAmount, getPaymentStatus } from '../types'
import type { Currency } from '../types'
import { PaymentBadge } from '../components/StatusBadge'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import PageHeader from '../components/PageHeader'
import { printPaymentReceipt } from '../lib/pdf'
import { shipmentFinancialSummary } from '../lib/accounting'
import toast from 'react-hot-toast'
import type { Screen } from '../App'

interface Props { onNavigate: (s: Screen, id?: string) => void }

const METHODS = ['Bank Transfer', 'Cash', 'M-Pesa', 'Tigopesa', 'Airtel Money', 'Cheque', 'Online Transfer']

export default function Payments({ onNavigate }: Props) {
  const { payments, shipments, customers, settings, addPayment, deletePayment, getPaymentsForShipment, getExtraChargesForShipment } = useAppStore()
  const currentUser = useAuthStore(s => s.currentUser)

  const [q, setQ] = useState('')
  const [methodFilter, setMethodFilter] = useState('')
  const [payModal, setPayModal] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [form, setForm] = useState({ shipmentId: '', amount: '', method: 'Bank Transfer', date: new Date().toISOString().slice(0, 10), note: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [paymentAttemptKey, setPaymentAttemptKey] = useState(() => crypto.randomUUID())

  const getShipment = (id: string | undefined) => id ? shipments.find(s => s.id === id) : undefined
  const getCustomer = (cid: string) => customers.find(c => c.id === cid)
  const invoiceCurrency = (shipment: typeof shipments[number]) => shipment.invoiceCurrency ?? shipment.currency
  const invoiceTotal = (shipment: typeof shipments[number]) => shipment.invoiceAmount ?? shipment.totalAmount
  const financialSummary = (shipment: typeof shipments[number]) => shipmentFinancialSummary(
    invoiceTotal(shipment),
    shipment.amountPaid,
    getExtraChargesForShipment(shipment.id),
  )

  const filtered = useMemo(() => {
    let list = [...payments].sort((a, b) => b.date.localeCompare(a.date))
    if (q) {
      const lq = q.toLowerCase()
      list = list.filter(p => {
        const s = getShipment(p.shipmentId)
        const c = s ? getCustomer(s.customerId) : null
        return p.receiptNumber.toLowerCase().includes(lq) ||
          s?.trackingNumber.toLowerCase().includes(lq) ||
          c?.company.toLowerCase().includes(lq) ||
          p.method.toLowerCase().includes(lq)
      })
    }
    if (methodFilter) list = list.filter(p => p.method === methodFilter)
    return list
  }, [payments, shipments, customers, q, methodFilter])

  const totals = useMemo(() => {
    const byCurrency: Record<string, number> = {}
    filtered.forEach(p => { byCurrency[p.currency] = (byCurrency[p.currency] || 0) + p.amount })
    return byCurrency
  }, [filtered])

  function openPayModal() {
    setForm({ shipmentId: '', amount: '', method: 'Bank Transfer', date: new Date().toISOString().slice(0, 10), note: '' })
    setErrors({})
    setPaymentAttemptKey(crypto.randomUUID())
    setPayModal(true)
  }

  async function handleSave() {
    const e: Record<string, string> = {}
    if (!form.shipmentId) e.shipmentId = 'Select a shipment'
    const shipment = getShipment(form.shipmentId)
    const amt = parseFloat(form.amount)
    if (!amt || amt <= 0) e.amount = 'Valid amount required'
    if (shipment) {
      const balance = financialSummary(shipment).balance
      if (amt > balance + 0.01) e.amount = `Max: ${formatAmount(balance, invoiceCurrency(shipment))}`
    }
    if (!form.date) e.date = 'Date required'
    if (Object.keys(e).length) { setErrors(e); return }
    if (saving) return
    setSaving(true)
    try {
      const payment = await addPayment({
        shipmentId: form.shipmentId,
        amount: amt,
        currency: invoiceCurrency(shipment!),
        method: form.method,
        date: form.date,
        note: form.note,
        idempotencyKey: paymentAttemptKey,
      })
      toast.success(`Receipt ${payment.receiptNumber} recorded!`)
      // addPayment() already re-fetches the DB-confirmed row and commits it into the
      // store before resolving, so getPaymentsForShipment() here already includes this
      // payment exactly once — do NOT .concat(payment) again (that double-counted the
      // just-recorded amount on the very first print; see printPaymentReceipt's totalPaid sum).
      void printPaymentReceipt(payment, shipment!, getCustomer(shipment!.customerId), settings, getPaymentsForShipment(form.shipmentId), getExtraChargesForShipment(form.shipmentId))
      setPayModal(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to record payment.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deletePayment(deleteTarget)
      toast.success('Payment deleted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete payment.')
    }
    setDeleteTarget(null)
  }

  const selectedShipment = getShipment(form.shipmentId)
  const balance = selectedShipment ? financialSummary(selectedShipment).balance : 0

  return (
    <div className="app-page">
      <PageHeader
        title="Payments"
        description={`${filtered.length} records`}
        action={<button onClick={openPayModal} className="primary-button gap-2"><PlusIcon /> Record Payment</button>}
      />

      {/* Totals */}
      {Object.keys(totals).length > 0 && (
        <div className="flex gap-3 mb-5 flex-wrap">
          {Object.entries(totals).map(([cur, amt]) => (
            <div key={cur} className="premium-card flex items-center gap-3 px-4 py-3">
              <div className="size-2 rounded-full bg-emerald-400" />
              <div>
                <div className="text-xs text-slate-400">Collected ({cur})</div>
                <div className="font-bold tabular text-sm text-slate-800">{formatAmount(amt, cur as Currency)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="relative min-w-0">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-slate-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search receipt #, tracking #, customer…" className="form-input pl-8" />
        </div>
        <select value={methodFilter} onChange={e => setMethodFilter(e.target.value)} className="form-input sm:w-auto">
          <option value="">All Methods</option>
          {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Receipt #</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Shipment</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Method</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Amount</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Date</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Balance</th>
                <th className="px-4 py-3 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.length === 0 && <tr><td colSpan={8} className="text-center py-12 text-slate-400 text-sm">No payments found.</td></tr>}
              {filtered.map(p => {
                const s = getShipment(p.shipmentId)
                const c = s ? getCustomer(s.customerId) : null
                const payStatus = s ? financialSummary(s).paymentStatus : null
                return (
                  <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5"><span className="font-mono text-xs font-semibold text-navy-700">{p.receiptNumber}</span></td>
                    <td className="px-4 py-3.5">
                      {s
                        ? <button onClick={() => onNavigate('shipment-detail', s.id)} className="font-mono text-xs text-navy-700 hover:underline">{s.trackingNumber}</button>
                        : <span className="font-mono text-xs text-slate-400" title="Shipment deleted — financial record retained">{p.shipmentTrackingSnapshot || '—'}</span>}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-medium text-slate-800 truncate max-w-[160px]">{c?.company || (!s ? 'Shipment deleted' : '—')}</div>
                    </td>
                    <td className="px-4 py-3.5 text-slate-600 text-xs">{p.method}</td>
                    <td className="px-4 py-3.5 text-right"><span className="font-semibold tabular text-emerald-700">{formatAmount(p.amount, p.currency)}</span></td>
                    <td className="px-4 py-3.5 text-slate-600 text-xs tabular">{p.date}</td>
                    <td className="px-4 py-3.5 text-center">{payStatus && <PaymentBadge status={payStatus} />}</td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => s && c && printPaymentReceipt(p, s, c, settings, getPaymentsForShipment(s.id), getExtraChargesForShipment(s.id))} title="Print Receipt" className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600"><PrintIcon /></button>
                        {p.status !== 'POSTED' && !p.accountingJournalEntryId && <button onClick={() => setDeleteTarget(p.id)} title="Delete" className="p-1.5 rounded-md hover:bg-red-50 text-slate-400 hover:text-red-500"><TrashIcon /></button>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-100 md:hidden">
          {filtered.length === 0 && <p className="px-4 py-10 text-center text-sm text-slate-400">No payments found.</p>}
          {filtered.map(payment => {
            const shipment = getShipment(payment.shipmentId)
            const customer = shipment ? getCustomer(shipment.customerId) : null
            const paymentStatus = shipment ? financialSummary(shipment).paymentStatus : null
            return <article key={payment.id} className="p-4"><div className="flex items-start justify-between gap-3"><div><div className="font-mono text-sm font-bold text-navy-700">{payment.receiptNumber}</div>{shipment ? <button onClick={() => onNavigate('shipment-detail', shipment.id)} className="mt-1 min-h-11 py-2 text-left font-mono text-xs font-semibold text-navy-700">{shipment.trackingNumber}</button> : <div className="mt-1 py-2 font-mono text-xs text-slate-400">{payment.shipmentTrackingSnapshot || '—'}</div>}</div>{paymentStatus && <PaymentBadge status={paymentStatus} />}</div><div className="mt-2 font-semibold text-slate-900">{customer?.company || customer?.name || (!shipment ? 'Shipment deleted' : '—')}</div><dl className="mt-3 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-slate-400">Method / Date</dt><dd className="mt-1 text-slate-700">{payment.method} · {payment.date}</dd></div><div className="text-right"><dt className="text-slate-400">Amount</dt><dd className="mt-1 font-bold text-emerald-700">{formatAmount(payment.amount, payment.currency)}</dd></div></dl><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={() => shipment && customer && printPaymentReceipt(payment, shipment, customer, settings, getPaymentsForShipment(shipment.id), getExtraChargesForShipment(shipment.id))} className="secondary-button min-h-11">Print Receipt</button><button onClick={() => setDeleteTarget(payment.id)} className="min-h-11 rounded-lg border border-red-200 text-sm font-semibold text-red-600">Delete</button></div></article>
          })}
        </div>
      </div>

      {/* Record Payment Modal */}
      <Modal open={payModal} onClose={() => setPayModal(false)} title="Record Payment">
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Shipment <span className="text-red-500">*</span></label>
            <select value={form.shipmentId} onChange={e => setForm(f => ({ ...f, shipmentId: e.target.value, amount: '' }))} className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none ${errors.shipmentId ? 'border-red-300' : 'border-slate-200'}`}>
              <option value="">Select shipment…</option>
              {shipments.filter(s => financialSummary(s).balance > 0).map(s => {
                const c = getCustomer(s.customerId)
                return <option key={s.id} value={s.id}>{s.trackingNumber} — {c?.company || 'Unknown'} (bal: {formatAmount(financialSummary(s).balance, invoiceCurrency(s))})</option>
              })}
            </select>
            {errors.shipmentId && <p className="text-xs text-red-500 mt-0.5">{errors.shipmentId}</p>}
          </div>
          {selectedShipment && (
            <div className="p-3 bg-slate-50 rounded-lg text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Total</span><span className="font-medium">{formatAmount(financialSummary(selectedShipment).totalDue, invoiceCurrency(selectedShipment))}</span>
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-slate-500">Paid</span><span className="text-emerald-600 font-medium">{formatAmount(selectedShipment.amountPaid, invoiceCurrency(selectedShipment))}</span>
              </div>
              <div className="flex justify-between mt-1 font-semibold">
                <span className="text-red-600">Balance</span><span className="text-red-600">{formatAmount(balance, invoiceCurrency(selectedShipment))}</span>
              </div>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Amount <span className="text-red-500">*</span></label>
            <input value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} type="number" min="0"
              placeholder={selectedShipment ? `Max: ${formatAmount(balance, invoiceCurrency(selectedShipment))}` : '0'}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none ${errors.amount ? 'border-red-300' : 'border-slate-200'}`} />
            {errors.amount && <p className="text-xs text-red-500 mt-0.5">{errors.amount}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Method</label>
            <select value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
              {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Date <span className="text-red-500">*</span></label>
            <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none ${errors.date ? 'border-red-300' : 'border-slate-200'}`} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Note</label>
            <input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="Optional note" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row">
            <button onClick={() => setPayModal(false)} disabled={saving} className="secondary-button min-h-11 flex-1">Cancel</button>
            <button onClick={handleSave} disabled={saving} className="min-h-11 flex-1 rounded-lg bg-cargo-500 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Recording…' : 'Record & Print Receipt'}</button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog open={!!deleteTarget} title="Delete Payment" message="Delete this payment record? The shipment balance will be recalculated." onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
    </div>
  )
}

const PlusIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
const SearchIcon = ({ className }: { className?: string }) => <svg className={className || 'size-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
const PrintIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
const TrashIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
