import { useState, useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore, canAccess } from '../store/useAuthStore'
import { formatAmount } from '../types'
import type { Currency, ExpenseCategory, Expense } from '../types'
import { EXPENSE_CATEGORIES } from '../types'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import PageHeader from '../components/PageHeader'
import toast from 'react-hot-toast'
import type { Screen } from '../App'

interface Props { onNavigate: (s: Screen) => void }

const CATEGORIES: ExpenseCategory[] = EXPENSE_CATEGORIES
const CURRENCIES: Currency[] = ['TZS', 'USD', 'AED']

const BLANK = { description: '', category: '' as ExpenseCategory | '', amount: '', currency: 'TZS' as Currency, date: new Date().toISOString().slice(0, 10), reference: '', notes: '', payee: '', paymentMethod: 'Bank Transfer' }

export default function Expenses({ onNavigate }: Props) {
  const { expenses, addExpense, updateExpense, deleteExpense } = useAppStore()
  const currentUser = useAuthStore(s => s.currentUser)

  const [q, setQ] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [modal, setModal] = useState<null | 'add' | 'edit'>(null)
  const [editing, setEditing] = useState<Expense | null>(null)
  const [form, setForm] = useState({ ...BLANK })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // One key per opened form. It is what makes a double submit land as a single
  // expense: the server returns the original row for a repeat of the same key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  if (!canAccess(currentUser?.role, 'expenses')) {
    return (
      <div className="min-h-full flex items-center justify-center p-12 bg-slate-50">
        <div className="text-center">
          <div className="size-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4"><LockIcon /></div>
          <h2 className="text-base font-semibold text-slate-800 mb-1">Access Restricted</h2>
          <p className="text-sm text-slate-400">Only admins can view the Expenses module.</p>
        </div>
      </div>
    )
  }

  const filtered = useMemo(() => {
    let list = [...expenses].sort((a, b) => b.date.localeCompare(a.date))
    if (q) { const lq = q.toLowerCase(); list = list.filter(e => e.description.toLowerCase().includes(lq) || e.reference?.toLowerCase().includes(lq) || e.category.toLowerCase().includes(lq)) }
    if (catFilter) list = list.filter(e => e.category === catFilter)
    if (dateFrom) list = list.filter(e => e.date >= dateFrom)
    if (dateTo) list = list.filter(e => e.date <= dateTo)
    return list
  }, [expenses, q, catFilter, dateFrom, dateTo])

  const totals = useMemo(() => {
    const byCurrency: Record<string, number> = {}
    filtered.forEach(e => { byCurrency[e.currency] = (byCurrency[e.currency] || 0) + e.amount })
    return byCurrency
  }, [filtered])

  function openAdd() { setForm({ ...BLANK }); setErrors({}); setSaving(false); setIdempotencyKey(crypto.randomUUID()); setModal('add') }
  function openEdit(e: Expense) { setEditing(e); setSaving(false); setForm({ description: e.description, category: e.category, amount: String(e.amount), currency: e.currency, date: e.date, reference: e.reference || '', notes: e.notes || '', payee: e.payee || '', paymentMethod: e.paymentMethod || 'Bank Transfer' }); setErrors({}); setModal('edit') }

  function validate() {
    const e: Record<string, string> = {}
    if (!form.description.trim()) e.description = 'Required'
    if (!form.category) e.category = 'Required'
    if (!form.amount || parseFloat(form.amount) <= 0) e.amount = 'Valid amount required'
    if (!form.date) e.date = 'Required'
    return e
  }

  async function handleSave() {
    if (saving) return
    const e = validate()
    if (Object.keys(e).length) { setErrors(e); return }
    const payload = { description: form.description, category: form.category as ExpenseCategory, amount: parseFloat(form.amount), currency: form.currency, date: form.date, reference: form.reference, notes: form.notes, payee: form.payee, paymentMethod: form.paymentMethod, createdBy: currentUser?.email || 'system' }
    setSaving(true)
    try {
      if (modal === 'add') {
        await addExpense({ ...payload, idempotencyKey })
        toast.success('Expense added')
      } else if (editing) {
        await updateExpense(editing.id, payload)
        toast.success('Expense updated')
      }
      setModal(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save expense.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await deleteExpense(deleteTarget)
      toast.success('Expense deleted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete expense.')
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
  }

  const set = (k: keyof typeof BLANK, v: string) => setForm(f => ({ ...f, [k]: v }))

  return (
    <div className="app-page">
      <PageHeader title="Expenses" description={`${filtered.length} records`} action={<button onClick={openAdd} className="primary-button gap-2"><PlusIcon /> Add Expense</button>} />

      {/* Totals */}
      {Object.keys(totals).length > 0 && (
        <div className="flex gap-3 mb-5 flex-wrap">
          {Object.entries(totals).map(([cur, amt]) => (
            <div key={cur} className="premium-card flex items-center gap-3 px-4 py-3">
              <div className="size-2 rounded-full bg-red-400" />
              <div>
                <div className="text-xs text-slate-400">Total Expenses ({cur})</div>
                <div className="font-bold tabular text-sm text-red-700">{formatAmount(amt, cur as Currency)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-slate-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search description, reference…" className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none" />
        </div>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none" title="From date" />
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none" title="To date" />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Description</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Category</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Amount</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Date</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Reference / Status</th>
                <th className="px-4 py-3 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.length === 0 && <tr><td colSpan={6} className="text-center py-12 text-slate-400 text-sm">No expenses found.</td></tr>}
              {filtered.map(e => (
                <tr key={e.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-slate-800">{e.description}</div>
                    {e.notes && <div className="text-xs text-slate-400 mt-0.5">{e.notes}</div>}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">{e.category}</span>
                  </td>
                  <td className="px-4 py-3.5 text-right"><span className="font-semibold tabular text-red-700">{formatAmount(e.amount, e.currency)}</span></td>
                  <td className="px-4 py-3.5 text-slate-600 tabular text-xs">{e.date}</td>
                  <td className="px-4 py-3.5 text-slate-500 font-mono text-xs">{e.reference || '—'}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center justify-end gap-1">
                      {e.status !== 'POSTED' && !e.accountingJournalEntryId && <><button onClick={() => openEdit(e)} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600"><EditIcon /></button><button onClick={() => setDeleteTarget(e.id)} className="p-1.5 rounded-md hover:bg-red-50 text-slate-400 hover:text-red-500"><TrashIcon /></button></>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add Expense' : 'Edit Expense'}>
        <div className="space-y-3">
          <FormRow label="Description" required error={errors.description}>
            <input value={form.description} onChange={e => set('description', e.target.value)} placeholder="e.g. Office rent — August" className={fi(!!errors.description)} />
          </FormRow>
          <div className="grid grid-cols-2 gap-3">
            <FormRow label="Payee"><input value={form.payee} onChange={e => set('payee', e.target.value)} placeholder="Supplier or staff" className={fi(false)} /></FormRow>
            <FormRow label="Paid Via"><select value={form.paymentMethod} onChange={e => set('paymentMethod', e.target.value)} className={fi(false)}><option>Bank Transfer</option><option>Cash</option></select></FormRow>
          </div>
          <FormRow label="Category" required error={errors.category}>
            <select value={form.category} onChange={e => set('category', e.target.value)} className={fi(!!errors.category)}>
              <option value="">Select category…</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormRow>
          <div className="grid grid-cols-2 gap-3">
            <FormRow label="Amount" required error={errors.amount}>
              <input type="number" min="0" value={form.amount} onChange={e => set('amount', e.target.value)} placeholder="0.00" className={fi(!!errors.amount)} />
            </FormRow>
            <FormRow label="Currency">
              <select value={form.currency} onChange={e => set('currency', e.target.value)} className={fi(false)}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </FormRow>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormRow label="Date" required error={errors.date}>
              <input type="date" value={form.date} onChange={e => set('date', e.target.value)} className={fi(!!errors.date)} />
            </FormRow>
            <FormRow label="Reference #">
              <input value={form.reference} onChange={e => set('reference', e.target.value)} placeholder="e.g. INV-001" className={fi(false)} />
            </FormRow>
          </div>
          <FormRow label="Note">
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} className={`resize-none ${fi(false)}`} placeholder="Optional…" />
          </FormRow>
          <div className="flex gap-2 pt-1">
            <button onClick={() => setModal(null)} disabled={saving} className="flex-1 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">Cancel</button>
            <button onClick={handleSave} disabled={saving} className="flex-1 py-2 text-sm font-semibold text-white rounded-lg disabled:cursor-not-allowed disabled:opacity-60" style={{ backgroundColor: 'rgb(249,115,22)' }}>
              {saving ? 'Saving…' : modal === 'add' ? 'Add Expense' : 'Save Changes'}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog open={!!deleteTarget} title="Delete Expense" message="Delete this expense record permanently?" busy={deleting} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
    </div>
  )
}

function FormRow({ label, required, error, children }: { label: string; required?: boolean; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}{required && <span className="text-red-500 ml-0.5">*</span>}</label>
      {children}
      {error && <p className="text-xs text-red-500 mt-0.5">{error}</p>}
    </div>
  )
}

const fi = (err: boolean) => `w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${err ? 'border-red-300 focus:ring-red-200' : 'border-slate-200 focus:ring-navy-100'}`

const PlusIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
const SearchIcon = ({ className }: { className?: string }) => <svg className={className || 'size-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
const EditIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
const TrashIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
const LockIcon = () => <svg className="size-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
