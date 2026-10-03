import { useState } from 'react'
import { useAuthStore } from '../store/useAuthStore'
import { PASSWORD_REQUIREMENTS, passwordValidationError } from '../lib/password'
import BrandLogo from '../components/BrandLogo'

export default function RequiredPasswordChange() {
  const completePasswordChange = useAuthStore(state => state.completePasswordChange)
  const logout = useAuthStore(state => state.logout)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const validationError = passwordValidationError(password)
    if (validationError) return setError(validationError)
    if (password !== confirmPassword) return setError('Passwords do not match.')
    setSaving(true)
    setError('')
    try {
      await completePasswordChange(password)
      setPassword('')
      setConfirmPassword('')
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : 'Password could not be changed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-slate-100 px-4 py-8 safe-area-page sm:px-6">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl sm:p-8">
        <BrandLogo className="mb-6 h-12 w-auto" priority />
        <h1 className="text-xl font-bold text-slate-900">Create a New Password</h1>
        <p className="mt-1 text-sm text-slate-500">Your temporary password must be replaced before accessing cargo data.</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {error && <div role="alert" className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          <div>
            <label htmlFor="new-password" className="form-label text-sm">New Password</label>
            <div className="relative">
              <input id="new-password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" className="form-input min-h-11 pr-20" />
              <button type="button" onClick={() => setShowPassword(value => !value)} className="absolute inset-y-0 right-1 min-w-16 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-50">{showPassword ? 'Hide' : 'Show'}</button>
            </div>
          </div>
          <div>
            <label htmlFor="confirm-password" className="form-label text-sm">Confirm Password</label>
            <input id="confirm-password" type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" className="form-input min-h-11" />
          </div>

          <ul className="grid gap-1.5 rounded-xl bg-slate-50 p-3 text-xs sm:grid-cols-2">
            {PASSWORD_REQUIREMENTS.map(requirement => {
              const met = requirement.test(password)
              return <li key={requirement.label} className={met ? 'text-emerald-700' : 'text-slate-500'}>{met ? '✓' : '○'} {requirement.label}</li>
            })}
          </ul>

          <button type="submit" disabled={saving} className="primary-button min-h-11 w-full">{saving ? 'Updating…' : 'Change Password & Continue'}</button>
          <button type="button" onClick={logout} className="secondary-button min-h-11 w-full">Sign Out</button>
        </form>
      </section>
    </main>
  )
}
