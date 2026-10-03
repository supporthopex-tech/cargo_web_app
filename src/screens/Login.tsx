import { useState } from 'react'
import toast from 'react-hot-toast'
import { useAuthStore } from '../store/useAuthStore'
import BrandLogo from '../components/BrandLogo'

export default function Login() {
  const login = useAuthStore(state => state.login)
  const requestPasswordReset = useAuthStore(state => state.requestPasswordReset)
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!identifier.trim() || !password) {
      setError('Please enter your email/username and password.')
      return
    }
    setLoading(true)
    setError('')
    const result = await login(identifier, password)
    setLoading(false)
    if (!result.success) setError(result.error || 'Invalid email/username or password.')
  }

  async function handleForgotPassword() {
    if (!identifier.trim()) {
      setError('Enter your email or username first, then choose Forgot Password.')
      return
    }
    setResetLoading(true)
    setError('')
    try {
      await requestPasswordReset(identifier)
      toast.success('If the account is active, password reset instructions have been sent.')
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Password reset could not be requested.')
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <main className="login-page safe-area-page">
      <div className="login-atmosphere" aria-hidden="true">
        <span className="login-glow login-glow-one" />
        <span className="login-glow login-glow-two" />
        <span className="login-dot-field" />
      </div>

      <section className="login-card" aria-label="Hopex Express Cargo staff sign in">
        <div className="login-brand-panel">
          <div className="login-route-art" aria-hidden="true">
            <svg viewBox="0 0 720 420" fill="none" preserveAspectRatio="none">
              <path d="M-20 326C116 278 154 104 302 149C420 185 455 298 742 65" />
              <path d="M-10 363C142 318 222 223 358 242C496 261 556 184 740 108" />
              <circle cx="302" cy="149" r="5" />
              <circle cx="554" cy="187" r="5" />
            </svg>
          </div>
          <div className="login-brand-content">
            <div className="login-logo-stage">
              <BrandLogo className="login-logo" priority />
            </div>
            <div className="login-brand-copy">
              <span className="login-eyebrow"><span /> Cargo Management Platform</span>
              <h1>Welcome to Hopex Express Cargo</h1>
              <p className="login-desktop-copy">Your trusted workspace for managing shipments, customers and cargo operations with speed, accuracy and confidence.</p>
              <p className="login-mobile-copy">Manage your cargo operations from anywhere.</p>
              <p className="login-supporting-copy">Everything your team needs to keep cargo moving — all in one place.</p>
            </div>
          </div>
        </div>

        <div className="login-form-panel">
          <div className="login-form-wrap">
            <div className="login-form-heading">
              <span className="login-kicker">Secure staff access</span>
              <h2>Welcome Back</h2>
              <p>Sign in to continue to your Hopex Express Cargo workspace.</p>
            </div>

            <form onSubmit={handleSubmit} className="login-form">
              {error && (
                <div role="alert" className="login-alert">
                  <AlertIcon />
                  <span>{error}</span>
                </div>
              )}

              <div className="login-field">
                <label htmlFor="login-identifier">Email or Username</label>
                <div className="login-input-wrap">
                  <UserIcon />
                  <input
                    id="login-identifier"
                    value={identifier}
                    onChange={event => setIdentifier(event.target.value)}
                    placeholder="Enter your email or username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={loading}
                  />
                </div>
              </div>

              <div className="login-field">
                <label htmlFor="login-password">Password</label>
                <div className="login-input-wrap">
                  <LockIcon />
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(value => !value)}
                    className="login-password-toggle"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              <div className="login-options">
                <label className="remember-control">
                  <input type="checkbox" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} />
                  <span>Remember me</span>
                </label>
                <button type="button" onClick={handleForgotPassword} disabled={resetLoading || loading} className="forgot-link">
                  {resetLoading ? 'Sending...' : 'Forgot password?'}
                </button>
              </div>

              <button type="submit" disabled={loading} className="login-submit">
                {loading && <span className="button-spinner" aria-hidden="true" />}
                {loading ? 'Signing In...' : 'Sign In'}
                {!loading && <ArrowRightIcon />}
              </button>

              <p className="login-admin-note"><ShieldIcon /> Staff accounts are created and managed by your Hopex Admin.</p>
            </form>
          </div>
          <p className="login-copyright">© 2026 Hopex Express Cargo. Secure internal workspace.</p>
        </div>
      </section>
    </main>
  )
}

function AlertIcon() {
  return <svg className="size-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
}

const UserIcon = () => <svg aria-hidden="true" className="login-field-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.1a7.5 7.5 0 0115 0" /></svg>
const LockIcon = () => <svg aria-hidden="true" className="login-field-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7.5 10.5V7.875a4.5 4.5 0 119 0V10.5m-10.5 0h12a1.5 1.5 0 011.5 1.5v7.5H4.5V12A1.5 1.5 0 016 10.5z" /></svg>
const EyeIcon = () => <svg aria-hidden="true" className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" /><circle cx="12" cy="12" r="2.5" /></svg>
const EyeOffIcon = () => <svg aria-hidden="true" className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 3l18 18M10.6 6.2A9.8 9.8 0 0112 6c6 0 9.5 6 9.5 6a17.5 17.5 0 01-2.2 2.9M6.1 6.1C3.7 8 2.5 12 2.5 12s3.5 6 9.5 6c1.5 0 2.8-.4 4-1M9.8 9.8a3.1 3.1 0 004.4 4.4" /></svg>
const ArrowRightIcon = () => <svg aria-hidden="true" className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14m-5-5 5 5-5 5" /></svg>
const ShieldIcon = () => <svg aria-hidden="true" className="size-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3l7 3v5c0 4.6-2.9 8.1-7 10-4.1-1.9-7-5.4-7-10V6l7-3z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9.5 12l1.6 1.6 3.7-4" /></svg>
