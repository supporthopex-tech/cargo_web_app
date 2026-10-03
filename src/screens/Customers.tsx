import { useState, useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore, canAccess } from '../store/useAuthStore'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import TypedConfirmDialog from '../components/TypedConfirmDialog'
import PageHeader from '../components/PageHeader'
import { TANZANIA_CITIES } from '../types'
import type { Customer } from '../types'
import toast from 'react-hot-toast'
import type { Screen } from '../App'

interface Props { onNavigate: (s: Screen, id?: string) => void }

const BLANK: Omit<Customer, 'id' | 'createdAt' | 'updatedAt'> = {
  name: '', company: '', phone: '', email: '', address: '', city: '', notes: '',
}

export default function Customers({ onNavigate }: Props) {
  const { customers, shipments, addCustomer, updateCustomer, deleteCustomer, archiveCustomer, unarchiveCustomer } = useAppStore()
  const currentUser = useAuthStore(s => s.currentUser)
  const canDelete = canAccess(currentUser?.role, 'customer.delete')
  const canArchive = canAccess(currentUser?.role, 'customer.archive')

  const [q, setQ] = useState('')
  const [cityFilter, setCityFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [modal, setModal] = useState<null | 'add' | 'edit'>(null)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [form, setForm] = useState<typeof BLANK>({ ...BLANK })
  const [errors, setErrors] = useState<Partial<typeof BLANK>>({})
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<Customer | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)

  const filtered = useMemo(() => {
    let list = showArchived ? customers : customers.filter(c => !c.archivedAt)
    if (q) {
      const lq = q.toLowerCase()
      list = list.filter(c =>
        c.name.toLowerCase().includes(lq) ||
        c.company.toLowerCase().includes(lq) ||
        c.phone.includes(lq) ||
        c.email.toLowerCase().includes(lq) ||
        c.city.toLowerCase().includes(lq)
      )
    }
    if (cityFilter) list = list.filter(c => c.city === cityFilter)
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [customers, q, cityFilter])

  function validate(f: typeof BLANK) {
    const e: Partial<typeof BLANK> = {}
    if (!f.name.trim()) e.name = 'Name required'
    if (!f.company.trim()) e.company = 'Company required'
    if (!f.phone.trim()) e.phone = 'Phone required'
    if (!f.city) e.city = 'City required'
    return e
  }

  function openAdd() { setForm({ ...BLANK }); setErrors({}); setModal('add') }
  function openEdit(c: Customer) { setEditing(c); setForm({ name: c.name, company: c.company, phone: c.phone, email: c.email, address: c.address, city: c.city, notes: c.notes || '' }); setErrors({}); setModal('edit') }

  async function handleSave() {
    const e = validate(form)
    if (Object.keys(e).length) { setErrors(e); return }
    try {
      if (modal === 'add') {
        await addCustomer({ ...form, })
        toast.success('Customer added successfully')
      } else if (editing) {
        await updateCustomer(editing.id, { ...form })
        toast.success('Customer updated')
      }
      setModal(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save customer.')
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const hasShipments = shipments.some(s => s.customerId === deleteTarget.id)
    if (hasShipments) { toast.error('Cannot delete — customer has shipments.'); setDeleteTarget(null); return }
    try {
      await deleteCustomer(deleteTarget.id)
      toast.success('Customer deleted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete customer.')
    }
    setDeleteTarget(null)
  }

  async function handleArchive() {
    if (!archiveTarget) return
    setArchiveBusy(true)
    try {
      await archiveCustomer(archiveTarget.id)
      toast.success('Customer archived. It stays visible on their existing shipments but is hidden from new ones.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive customer.')
    } finally {
      setArchiveBusy(false)
      setArchiveTarget(null)
    }
  }

  async function handleUnarchive(customer: Customer) {
    try {
      await unarchiveCustomer(customer.id)
      toast.success('Customer restored.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restore customer.')
    }
  }

  const set = (k: keyof typeof BLANK, v: string) => setForm(f => ({ ...f, [k]: v }))

  const shipmentCountFor = (id: string) => shipments.filter(s => s.customerId === id).length

  return (
    <div className="app-page">
      <PageHeader
        title="Customers"
        description={`${filtered.length} of ${customers.length} customers`}
        action={<button onClick={openAdd} className="primary-button gap-2"><PlusIcon /> Add Customer</button>}
      />

      {/* Filters */}
      <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="relative min-w-0">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-slate-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, company, phone…" className="form-input pl-8" />
        </div>
        <select value={cityFilter} onChange={e => setCityFilter(e.target.value)} className="form-input sm:w-auto">
          <option value="">All Cities</option>
          {TANZANIA_CITIES.filter(c => c !== 'Other').map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <label className="mb-5 -mt-2 flex items-center gap-2 text-xs text-slate-500">
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="size-3.5 rounded border-slate-300" />
        Show archived customers ({customers.filter(c => c.archivedAt).length})
      </label>

      {/* Table */}
      <div className="data-surface">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Company</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Contact</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">City</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Phone</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Shipments</th>
                <th className="px-4 py-3 w-24" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="text-center py-12 text-slate-400 text-sm">No customers found.</td></tr>
              )}
              {filtered.map(c => {
                const hasShipments = shipmentCountFor(c.id) > 0
                return (
                <tr key={c.id} className={`hover:bg-slate-50 transition-colors ${c.archivedAt ? 'opacity-60' : ''}`}>
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-slate-800">{c.company}{c.archivedAt && <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600" title={c.archivedReason}>ARCHIVED</span>}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{c.address}</div>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="text-slate-700">{c.name}</div>
                    <div className="text-xs text-slate-400">{c.email}</div>
                  </td>
                  <td className="px-4 py-3.5 text-slate-600">{c.city}</td>
                  <td className="px-4 py-3.5 font-mono text-xs text-slate-600">{c.phone}</td>
                  <td className="px-4 py-3.5 text-center">
                    <button onClick={() => onNavigate('dashboard')} className="inline-flex items-center justify-center size-7 rounded-full bg-slate-100 text-slate-700 text-xs font-bold hover:bg-navy-100 transition-colors">
                      {shipmentCountFor(c.id)}
                    </button>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEdit(c)} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors" title="Edit">
                        <EditIcon />
                      </button>
                      {canArchive && c.archivedAt && (
                        <button onClick={() => handleUnarchive(c)} className="p-1.5 rounded-md hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 transition-colors" title="Restore">
                          <RestoreIcon />
                        </button>
                      )}
                      {canArchive && !c.archivedAt && hasShipments && (
                        <button onClick={() => setArchiveTarget(c)} className="p-1.5 rounded-md hover:bg-amber-50 text-slate-400 hover:text-amber-600 transition-colors" title="Archive">
                          <ArchiveIcon />
                        </button>
                      )}
                      {canDelete && !hasShipments && (
                        <button onClick={() => setDeleteTarget(c)} className="p-1.5 rounded-md hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors" title="Delete">
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-100 md:hidden">
          {filtered.length === 0 && <p className="px-4 py-10 text-center text-sm text-slate-400">No customers found.</p>}
          {filtered.map(customer => {
            const hasShipments = shipmentCountFor(customer.id) > 0
            return (
            <article key={customer.id} className={`mobile-data-card m-3 p-4 ${customer.archivedAt ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-bold text-slate-900">{customer.company}{customer.archivedAt && <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600" title={customer.archivedReason}>ARCHIVED</span>}</h2><p className="mt-0.5 text-sm text-slate-600">{customer.name}</p><a href={`tel:${customer.phone}`} className="mt-1 block min-h-11 py-2 font-mono text-sm text-navy-700">{customer.phone}</a></div><span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{shipmentCountFor(customer.id)} shipments</span></div>
              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-500"><span>{customer.city}</span><span className="truncate">{customer.email}</span></div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button onClick={() => openEdit(customer)} className="secondary-button min-h-11">Edit</button>
                <button onClick={() => onNavigate('dashboard')} className="primary-button min-h-11">View Shipments</button>
                {canArchive && customer.archivedAt && <button onClick={() => handleUnarchive(customer)} className="secondary-button min-h-11 col-span-2">Restore</button>}
                {canArchive && !customer.archivedAt && hasShipments && <button onClick={() => setArchiveTarget(customer)} className="secondary-button min-h-11 col-span-2 text-amber-700">Archive</button>}
                {canDelete && !hasShipments && <button onClick={() => setDeleteTarget(customer)} className="secondary-button min-h-11 col-span-2 text-red-600">Delete</button>}
              </div>
            </article>
            )
          })}
        </div>
      </div>

      {/* Add/Edit Modal */}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add Customer' : 'Edit Customer'}>
        <div className="space-y-3">
          <Row label="Contact Name" required error={errors.name}>
            <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Full name" className={fi(!!errors.name)} />
          </Row>
          <Row label="Company / Business Name" required error={errors.company}>
            <input value={form.company} onChange={e => set('company', e.target.value)} placeholder="Company name" className={fi(!!errors.company)} />
          </Row>
          <div className="grid gap-3 sm:grid-cols-2">
            <Row label="Phone" required error={errors.phone}>
              <input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+255 7XX XXX XXX" className={fi(!!errors.phone)} />
            </Row>
            <Row label="Email">
              <input type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="email@example.com" className={fi(false)} />
            </Row>
          </div>
          <Row label="City / Destination" required error={errors.city}>
            <select value={form.city} onChange={e => set('city', e.target.value)} className={fi(!!errors.city)}>
              <option value="">Select city…</option>
              {TANZANIA_CITIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Row>
          <Row label="Address">
            <input value={form.address} onChange={e => set('address', e.target.value)} placeholder="Street address" className={fi(false)} />
          </Row>
          <Row label="Notes">
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} className={`resize-none ${fi(false)}`} placeholder="Optional notes…" />
          </Row>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row">
            <button onClick={() => setModal(null)} className="secondary-button min-h-11 flex-1">Cancel</button>
            <button onClick={handleSave} className="min-h-11 flex-1 rounded-lg bg-cargo-500 text-sm font-semibold text-white">
              {modal === 'add' ? 'Add Customer' : 'Save Changes'}
            </button>
          </div>
        </div>
      </Modal>

      <TypedConfirmDialog
        open={!!deleteTarget}
        title="Delete Customer"
        message="This customer has no shipment history, so this permanently deletes their record. This cannot be undone."
        confirmText={deleteTarget?.company || ''}
        confirmLabel="Delete Permanently"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={!!archiveTarget}
        title="Archive Customer"
        message={`Archive "${archiveTarget?.company}"? They'll be hidden from new shipments but stay visible on their existing history. An Admin can restore them anytime.`}
        confirmLabel={archiveBusy ? 'Archiving…' : 'Archive'}
        danger={false}
        onConfirm={handleArchive}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  )
}

function Row({ label, required, error, children }: { label: string; required?: boolean; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {error && <p className="text-xs text-red-500 mt-0.5">{error}</p>}
    </div>
  )
}

const fi = (err: boolean) =>
  `form-input ${err ? 'border-red-300 focus:ring-red-200' : ''}`

const PlusIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
const SearchIcon = ({ className }: { className?: string }) => <svg className={className || 'size-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
const EditIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
const TrashIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
const ArchiveIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 01-2-2V5a1 1 0 011-1h16a1 1 0 011 1v1a2 2 0 01-2 2M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8M10 12h4" /></svg>
const RestoreIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
