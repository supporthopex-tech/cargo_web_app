import { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuthStore, canAccess } from '../store/useAuthStore'
import { PASSWORD_REQUIREMENTS, passwordValidationError } from '../lib/password'
import { avatarValidationError } from '../lib/avatar.ts'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import PageHeader from '../components/PageHeader'
import Avatar from '../components/Avatar'
import type { Screen } from '../App'
import type { User, UserRole } from '../types'

interface Props { onNavigate: (screen: Screen) => void }
type StaffModal = 'add' | 'edit' | 'reset' | null

const EMPTY_FORM = {
  name: '',
  username: '',
  email: '',
  phone: '',
  role: 'Operations Staff' as UserRole,
  password: '',
  confirmPassword: '',
  active: true,
  mustChangePassword: true,
}

export default function StaffRoles(_props: Props) {
  const { users, addUser, updateUser, resetPassword, setUserStatus, currentUser, loadUsers, uploadAvatar, removeAvatar } = useAuthStore()
  const [modal, setModal] = useState<StaffModal>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [statusTarget, setStatusTarget] = useState<User | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showPassword, setShowPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [credentials, setCredentials] = useState<{ name: string; login: string; username: string; password: string } | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)

  useEffect(() => {
    loadUsers().catch(error => toast.error(error instanceof Error ? error.message : 'Staff list could not be loaded.'))
  }, [loadUsers])

  const editingUser = useMemo(() => users.find(user => user.id === editingId) || null, [editingId, users])

  if (!canAccess(currentUser?.role, 'staff')) {
    return <RestrictedAccess />
  }

  function openAdd() {
    setForm(EMPTY_FORM)
    setErrors({})
    setEditingId(null)
    setShowPassword(false)
    setModal('add')
  }

  function openEdit(user: User) {
    setEditingId(user.id)
    setForm({
      ...EMPTY_FORM,
      name: user.name,
      username: user.username,
      email: user.email,
      phone: user.phone,
      role: user.role,
      active: user.active,
    })
    setErrors({})
    setModal('edit')
  }

  function openReset(user: User) {
    setEditingId(user.id)
    setForm({ ...EMPTY_FORM, password: '', confirmPassword: '', mustChangePassword: true })
    setErrors({})
    setShowPassword(false)
    setModal('reset')
  }

  function validateProfile() {
    const next: Record<string, string> = {}
    if (!form.name.trim()) next.name = 'Full name is required.'
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(form.username)) next.username = 'Use 3-32 lowercase letters, numbers, dots, dashes or underscores.'
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) next.email = 'A valid email is required.'
    if (modal === 'add') {
      const passwordError = passwordValidationError(form.password)
      if (passwordError) next.password = passwordError
      if (form.password !== form.confirmPassword) next.confirmPassword = 'Passwords do not match.'
    }
    return next
  }

  async function handleSaveProfile() {
    const nextErrors = validateProfile()
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    setSaving(true)
    try {
      if (modal === 'add') {
        await addUser({
          name: form.name.trim(),
          username: form.username,
          email: form.email.trim(),
          phone: form.phone.trim(),
          role: form.role,
          password: form.password,
          active: form.active,
          mustChangePassword: form.mustChangePassword,
        })
        setCredentials({
          name: form.name.trim(),
          login: form.email.trim(),
          username: form.username,
          password: form.password,
        })
        toast.success('Staff account created and active immediately.')
      } else if (editingId) {
        await updateUser(editingId, {
          name: form.name.trim(),
          username: form.username,
          email: form.email.trim(),
          phone: form.phone.trim(),
          role: form.role,
        })
        toast.success('Staff profile updated.')
      }
      setModal(null)
      setForm(EMPTY_FORM)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Staff could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  async function handleResetPassword() {
    const nextErrors: Record<string, string> = {}
    const passwordError = passwordValidationError(form.password)
    if (passwordError) nextErrors.password = passwordError
    if (form.password !== form.confirmPassword) nextErrors.confirmPassword = 'Passwords do not match.'
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    if (!editingId || !editingUser) return
    setSaving(true)
    try {
      await resetPassword(editingId, form.password, form.mustChangePassword)
      setCredentials({
        name: editingUser.name,
        login: editingUser.email,
        username: editingUser.username,
        password: form.password,
      })
      setModal(null)
      setForm(EMPTY_FORM)
      toast.success('Temporary password set.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Password could not be reset.')
    } finally {
      setSaving(false)
    }
  }

  async function handleAvatarFile(file: File | null) {
    if (!file || !editingId) return
    const validationError = avatarValidationError(file)
    if (validationError) { toast.error(validationError); return }
    setAvatarBusy(true)
    try {
      await uploadAvatar(editingId, file)
      toast.success('Staff photo updated.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Photo could not be uploaded.')
    } finally {
      setAvatarBusy(false)
      if (avatarInputRef.current) avatarInputRef.current.value = ''
    }
  }

  async function handleAvatarRemove() {
    if (!editingId) return
    setAvatarBusy(true)
    try {
      await removeAvatar(editingId)
      toast.success('Staff photo removed.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Photo could not be removed.')
    } finally {
      setAvatarBusy(false)
    }
  }

  async function handleStatusChange() {
    if (!statusTarget) return
    setSaving(true)
    try {
      await setUserStatus(statusTarget.id, !statusTarget.active)
      toast.success(statusTarget.active ? 'Staff account disabled.' : 'Staff account enabled.')
      setStatusTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Account status could not be changed.')
    } finally {
      setSaving(false)
    }
  }

  async function copyCredentials() {
    if (!credentials) return
    const text = `Hopex Express Cargo staff account\nName: ${credentials.name}\nEmail: ${credentials.login}\nUsername: ${credentials.username}\nTemporary password: ${credentials.password}`
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Login details copied. The password will not be shown again after closing.')
    } catch {
      toast.error('Copy failed. Copy the details manually before closing.')
    }
  }

  const setField = <Key extends keyof typeof form>(key: Key, value: typeof form[Key]) => {
    setForm(current => ({ ...current, [key]: value }))
    setErrors(current => ({ ...current, [key]: '' }))
  }

  return (
    <div className="app-page">
      <PageHeader title="Staff Management" description={`${users.length} staff accounts · Admin managed`} action={<button onClick={openAdd} className="primary-button">+ Add Staff</button>} />

      <section className="data-surface hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Staff</th><th className="px-4 py-3">Username</th><th className="px-4 py-3">Phone</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Last Login</th><th className="px-4 py-3">Created</th><th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map(user => <StaffRow key={user.id} user={user} isCurrent={user.id === currentUser?.id} onEdit={openEdit} onReset={openReset} onStatus={setStatusTarget} />)}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-3 md:hidden">
        {users.map(user => <StaffCard key={user.id} user={user} isCurrent={user.id === currentUser?.id} onEdit={openEdit} onReset={openReset} onStatus={setStatusTarget} />)}
      </section>

      <RolePermissions />

      <Modal open={modal === 'add' || modal === 'edit'} onClose={() => !saving && setModal(null)} title={modal === 'add' ? 'Add Staff' : 'Edit Staff'} width="max-w-2xl">
        {modal === 'edit' && editingUser && (
          <div className="mb-4 flex items-center gap-4 rounded-xl border border-slate-200 p-3">
            <Avatar path={editingUser.avatarPath} initials={editingUser.initials} sizeClass="size-14" />
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <input ref={avatarInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={event => handleAvatarFile(event.target.files?.[0] || null)} />
              <button type="button" disabled={avatarBusy} onClick={() => avatarInputRef.current?.click()} className="min-h-9 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50">
                {avatarBusy ? 'Working…' : editingUser.avatarPath ? 'Replace Photo' : 'Upload Photo'}
              </button>
              {editingUser.avatarPath && (
                <button type="button" disabled={avatarBusy} onClick={handleAvatarRemove} className="min-h-9 rounded-lg border border-red-200 px-3 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50">Remove Photo</button>
              )}
              <span className="w-full text-[11px] text-slate-400">JPG, PNG or WEBP · up to 2MB</span>
            </div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full Name" error={errors.name} required><input value={form.name} onChange={event => setField('name', event.target.value)} autoComplete="name" className={inputClass(errors.name)} /></FormField>
          <FormField label="Username" error={errors.username} required><input value={form.username} onChange={event => setField('username', event.target.value.toLowerCase().replace(/\s/g, ''))} autoCapitalize="none" spellCheck={false} className={inputClass(errors.username)} /></FormField>
          <FormField label="Email" error={errors.email} required><input type="email" value={form.email} onChange={event => setField('email', event.target.value)} autoComplete="email" className={inputClass(errors.email)} /></FormField>
          <FormField label="Phone Number"><input type="tel" value={form.phone} onChange={event => setField('phone', event.target.value)} autoComplete="tel" className={inputClass()} /></FormField>
          <FormField label="Role" required><select value={form.role} onChange={event => setField('role', event.target.value as UserRole)} className={inputClass()}><option>Operations Staff</option><option>Manager</option><option>Admin</option></select></FormField>
          {modal === 'add' && <label className="flex min-h-11 items-center gap-3 self-end rounded-xl border border-slate-200 px-3"><input type="checkbox" checked={form.active} onChange={event => setField('active', event.target.checked)} className="size-4" /><span className="text-sm text-slate-700">Account active immediately</span></label>}
          {modal === 'add' && <PasswordFields form={form} errors={errors} showPassword={showPassword} onToggle={() => setShowPassword(value => !value)} setField={setField} />}
        </div>
        {modal === 'add' && <PasswordRequirements password={form.password} />}
        {modal === 'add' && <label className="mt-4 flex items-start gap-3 rounded-xl bg-amber-50 p-3"><input type="checkbox" checked={form.mustChangePassword} onChange={event => setField('mustChangePassword', event.target.checked)} className="mt-0.5 size-4" /><span className="text-sm text-amber-900">Require password change on first login</span></label>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button onClick={() => setModal(null)} disabled={saving} className="secondary-button min-h-11">Cancel</button><button onClick={handleSaveProfile} disabled={saving} className="min-h-11 rounded-lg bg-cargo-500 px-5 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : modal === 'add' ? 'Create Active Staff' : 'Save Changes'}</button></div>
      </Modal>

      <Modal open={modal === 'reset'} onClose={() => !saving && setModal(null)} title={`Reset Password${editingUser ? ` · ${editingUser.name}` : ''}`}>
        <PasswordFields form={form} errors={errors} showPassword={showPassword} onToggle={() => setShowPassword(value => !value)} setField={setField} />
        <PasswordRequirements password={form.password} />
        <label className="mt-4 flex items-start gap-3 rounded-xl bg-amber-50 p-3"><input type="checkbox" checked={form.mustChangePassword} onChange={event => setField('mustChangePassword', event.target.checked)} className="mt-0.5 size-4" /><span className="text-sm text-amber-900">Require password change on next login</span></label>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button onClick={() => setModal(null)} className="secondary-button min-h-11">Cancel</button><button onClick={handleResetPassword} disabled={saving} className="primary-button min-h-11">{saving ? 'Resetting…' : 'Set Temporary Password'}</button></div>
      </Modal>

      <Modal open={!!credentials} onClose={() => setCredentials(null)} title="Staff Account Created">
        {credentials && <div className="space-y-4"><div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">The account is active now. These temporary credentials are shown once only.</div><dl className="grid gap-3 rounded-xl bg-slate-50 p-4 text-sm"><Credential label="Name" value={credentials.name} /><Credential label="Email" value={credentials.login} /><Credential label="Username" value={credentials.username} /><Credential label="Temporary Password" value={credentials.password} mono /></dl><button onClick={copyCredentials} className="primary-button min-h-11 w-full">Copy Login Details</button><button onClick={() => setCredentials(null)} className="secondary-button min-h-11 w-full">Close & Clear Password</button></div>}
      </Modal>

      <ConfirmDialog
        open={!!statusTarget}
        title={`${statusTarget?.active ? 'Disable' : 'Enable'} Staff Account`}
        message={statusTarget?.active ? `Disable ${statusTarget.name}'s account? Current and future protected access will be blocked.` : `Enable ${statusTarget?.name}'s account? They will be able to sign in again.`}
        confirmLabel={statusTarget?.active ? 'Disable Account' : 'Enable Account'}
        danger={statusTarget?.active}
        onConfirm={handleStatusChange}
        onCancel={() => !saving && setStatusTarget(null)}
      />
    </div>
  )
}

function StaffRow({ user, isCurrent, onEdit, onReset, onStatus }: StaffActionsProps) {
  return <tr className="hover:bg-slate-50"><td className="px-4 py-3"><div className="flex items-center gap-2.5"><Avatar path={user.avatarPath} initials={user.initials} sizeClass="size-8" /><div><div className="font-semibold text-slate-900">{user.name}{isCurrent && <span className="ml-1 rounded bg-navy-100 px-1.5 py-0.5 text-[10px] text-navy-700">You</span>}</div><div className="text-xs text-slate-500">{user.email}</div></div></div></td><td className="px-4 py-3 font-mono text-xs text-slate-600">@{user.username}</td><td className="px-4 py-3 text-xs text-slate-600">{user.phone || '—'}</td><td className="px-4 py-3"><RoleBadge role={user.role} /></td><td className="px-4 py-3"><StatusBadge active={user.active} /></td><td className="px-4 py-3 text-xs text-slate-500">{formatDate(user.lastLoginAt, true)}</td><td className="px-4 py-3 text-xs text-slate-500">{formatDate(user.createdAt)}</td><td className="px-4 py-3"><div className="flex justify-end gap-1"><ActionButton onClick={() => onEdit(user)}>Edit</ActionButton><ActionButton onClick={() => onReset(user)}>Reset Password</ActionButton><ActionButton onClick={() => onStatus(user)} disabled={isCurrent}>{user.active ? 'Disable' : 'Enable'}</ActionButton></div></td></tr>
}

function StaffCard({ user, isCurrent, onEdit, onReset, onStatus }: StaffActionsProps) {
  return <article className="mobile-data-card p-4"><div className="flex items-start gap-3"><Avatar path={user.avatarPath} initials={user.initials} sizeClass="size-11" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-bold text-slate-900">{user.name}</h2>{isCurrent && <span className="rounded bg-navy-100 px-1.5 py-0.5 text-[10px] text-navy-700">You</span>}<StatusBadge active={user.active} /></div><p className="truncate text-sm text-slate-600">{user.email}</p><p className="mt-0.5 font-mono text-xs text-slate-500">@{user.username}</p></div></div><dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-xs"><div><dt className="text-slate-400">Role</dt><dd className="mt-1"><RoleBadge role={user.role} /></dd></div><div><dt className="text-slate-400">Phone</dt><dd className="mt-1 text-slate-700">{user.phone || '—'}</dd></div><div><dt className="text-slate-400">Last Login</dt><dd className="mt-1 text-slate-700">{formatDate(user.lastLoginAt, true)}</dd></div><div><dt className="text-slate-400">Created</dt><dd className="mt-1 text-slate-700">{formatDate(user.createdAt)}</dd></div></dl><div className="mt-4 grid grid-cols-2 gap-2"><ActionButton onClick={() => onEdit(user)}>Edit Profile</ActionButton><ActionButton onClick={() => onReset(user)}>Reset Password</ActionButton><button onClick={() => onStatus(user)} disabled={isCurrent} className={`col-span-2 min-h-11 rounded-lg border px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${user.active ? 'border-red-200 text-red-700 hover:bg-red-50' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}>{user.active ? 'Disable Account' : 'Enable Account'}</button></div></article>
}

interface StaffActionsProps { user: User; isCurrent: boolean; onEdit: (user: User) => void; onReset: (user: User) => void; onStatus: (user: User) => void }

function ActionButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) { return <button onClick={onClick} disabled={disabled} className="min-h-11 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40">{children}</button> }
function RoleBadge({ role }: { role: UserRole }) { return <span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-bold ${role === 'Admin' ? 'bg-violet-100 text-violet-700' : role === 'Manager' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'}`}>{role}</span> }
function StatusBadge({ active }: { active: boolean }) { return <span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-bold ${active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{active ? 'ACTIVE' : 'DISABLED'}</span> }
function formatDate(value?: string, includeTime = false) { if (!value) return 'Never'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }) }
function inputClass(error?: string) { return `form-input min-h-11 ${error ? 'border-red-300 focus:border-red-400 focus:ring-red-100' : ''}` }

function FormField({ label, error, required, children }: { label: string; error?: string; required?: boolean; children: React.ReactNode }) { return <div><label className="form-label text-sm">{label}{required && <span className="ml-0.5 text-red-500">*</span>}</label>{children}{error && <p className="mt-1 text-xs text-red-600">{error}</p>}</div> }

function PasswordFields({ form, errors, showPassword, onToggle, setField }: { form: typeof EMPTY_FORM; errors: Record<string, string>; showPassword: boolean; onToggle: () => void; setField: <Key extends keyof typeof EMPTY_FORM>(key: Key, value: typeof EMPTY_FORM[Key]) => void }) {
  return <><FormField label="Temporary Password" error={errors.password} required><div className="relative"><input type={showPassword ? 'text' : 'password'} value={form.password} onChange={event => setField('password', event.target.value)} autoComplete="new-password" className={`${inputClass(errors.password)} pr-20`} /><button type="button" onClick={onToggle} className="absolute inset-y-0 right-1 min-w-16 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-50">{showPassword ? 'Hide' : 'Show'}</button></div></FormField><FormField label="Confirm Password" error={errors.confirmPassword} required><input type={showPassword ? 'text' : 'password'} value={form.confirmPassword} onChange={event => setField('confirmPassword', event.target.value)} autoComplete="new-password" className={inputClass(errors.confirmPassword)} /></FormField></>
}

function PasswordRequirements({ password }: { password: string }) { return <ul className="mt-4 grid gap-1 rounded-xl bg-slate-50 p-3 text-xs sm:grid-cols-2">{PASSWORD_REQUIREMENTS.map(requirement => { const met = requirement.test(password); return <li key={requirement.label} className={met ? 'text-emerald-700' : 'text-slate-500'}>{met ? '✓' : '○'} {requirement.label}</li> })}</ul> }
function Credential({ label, value, mono }: { label: string; value: string; mono?: boolean }) { return <div><dt className="text-xs text-slate-500">{label}</dt><dd className={`mt-0.5 break-all font-semibold text-slate-900 ${mono ? 'font-mono' : ''}`}>{value}</dd></div> }

function RolePermissions() {
  const rows = [
    ['Operational cargo, customers, QR, packing, tracking, payments', true, true, true],
    ['Expenses, reports and invoice/rate-aware management', true, true, false],
    ['Shipping rates, exchange rates and sensitive settings', true, true, false],
    ['Staff creation, roles, password reset and account status', true, false, false],
  ] as const
  return <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="border-b border-slate-100 bg-slate-50 px-4 py-3"><h2 className="text-sm font-bold text-slate-800">Role Permissions</h2><p className="mt-0.5 text-xs text-slate-500">Permissions remain tied to the existing server-enforced roles.</p></div><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-xs"><thead><tr className="border-b border-slate-100 text-slate-500"><th className="px-4 py-3 text-left">Capability</th><th className="px-3 py-3">Admin</th><th className="px-3 py-3">Manager</th><th className="px-3 py-3">Operations Staff</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map(([label, admin, manager, staff]) => <tr key={label}><td className="px-4 py-3 text-slate-700">{label}</td>{[admin, manager, staff].map((allowed, index) => <td key={index} className={`px-3 py-3 text-center font-bold ${allowed ? 'text-emerald-600' : 'text-slate-300'}`}>{allowed ? '✓' : '—'}</td>)}</tr>)}</tbody></table></div></section>
}

function RestrictedAccess() { return <div className="flex min-h-full items-center justify-center bg-slate-50 p-6"><div className="max-w-sm text-center"><div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-red-50 text-2xl">🔒</div><h1 className="font-bold text-slate-900">Access Restricted</h1><p className="mt-1 text-sm text-slate-500">Only active Admin accounts can manage staff.</p></div></div> }
