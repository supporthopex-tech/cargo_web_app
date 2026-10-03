import { lazy, Suspense, useEffect, useState } from 'react'
import BrandLogo from './components/BrandLogo'
import { Toaster } from 'react-hot-toast'
import { useAuthStore } from './store/useAuthStore'
import { useAppStore } from './store/useAppStore'
import { useRatesStore } from './store/useRatesStore'
import { useAccountingStore } from './store/useAccountingStore'
import Login from './screens/Login'
import RequiredPasswordChange from './screens/RequiredPasswordChange'
import { useLocalStorage } from './lib/useLocalStorage'
import DocumentsDrawer from './components/DocumentsDrawer'
import Avatar from './components/Avatar'
import MyProfileModal from './components/MyProfileModal'
import { BRAND } from './config/brand.ts'
import { hasPermission, type PermissionCode } from './lib/permissions'
import type { ShipmentStatus } from './types'

const Dashboard = lazy(() => import('./screens/Dashboard'))
const Shipments = lazy(() => import('./screens/Shipments'))
const CreateShipment = lazy(() => import('./screens/CreateShipment'))
const ShipmentDetail = lazy(() => import('./screens/ShipmentDetail'))
const PublicTracking = lazy(() => import('./screens/PublicTracking'))
const PackingList = lazy(() => import('./screens/PackingList'))
const ScanItem = lazy(() => import('./screens/ScanItem'))
const ItemDetails = lazy(() => import('./screens/ItemDetails'))
const Customers = lazy(() => import('./screens/Customers'))
const Storage = lazy(() => import('./screens/Storage'))
const Payments = lazy(() => import('./screens/Payments'))
const Expenses = lazy(() => import('./screens/Expenses'))
const Settings = lazy(() => import('./screens/Settings'))
const StaffRoles = lazy(() => import('./screens/StaffRoles'))
const FinancialReports = lazy(() => import('./screens/FinancialReports'))

function FolderOpenIcon() {
  return <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" /></svg>
}

export type Screen =
  | 'dashboard'
  | 'shipments'
  | 'create-shipment'
  | 'shipment-detail'
  | 'public-tracking'
  | 'packing-list'
  | 'scan-item'
  | 'item-detail'
  | 'customers'
  | 'storage'
  | 'payments'
  | 'expenses'
  | 'reports'
  | 'staff'
  | 'settings'

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: GridIcon, screen: 'dashboard' as Screen, permission: 'dashboard.view' as PermissionCode },
  { id: 'shipments', label: 'Shipments', icon: BoxIcon, screen: 'shipments' as Screen, permission: 'shipments.view' as PermissionCode },
  { id: 'customers', label: 'Customers', icon: UsersIcon, screen: 'customers' as Screen, permission: 'customers.view' as PermissionCode },
  { id: 'packing-list', label: 'Packing Lists', icon: ListIcon, screen: 'packing-list' as Screen, permission: 'packing.view' as PermissionCode },
  { id: 'scan-item', label: 'Scan Item', icon: QrScanIcon, screen: 'scan-item' as Screen, permission: 'packing.view' as PermissionCode },
  { id: 'storage', label: 'Storage', icon: WarehouseIcon, screen: 'storage' as Screen, permission: 'packing.view' as PermissionCode },
  { id: 'payments', label: 'Payments', icon: ReceiptIcon, screen: 'payments' as Screen, permission: 'payments.view' as PermissionCode },
  { id: 'divider1', label: '', icon: null, screen: null as unknown as Screen },
  { id: 'expenses', label: 'Expenses', icon: WalletIcon, screen: 'expenses' as Screen, permission: 'expenses.view' as PermissionCode },
  { id: 'reports', label: 'Financial Reports', icon: ChartIcon, screen: 'reports' as Screen, permission: 'reports.view' as PermissionCode },
  { id: 'staff', label: 'Staff Management', icon: ShieldIcon, screen: 'staff' as Screen, permission: 'staff.view' as PermissionCode },
  { id: 'settings', label: 'Company Settings', icon: CogIcon, screen: 'settings' as Screen, permission: 'settings.view' as PermissionCode },
]

const SCREEN_PERMISSIONS: Partial<Record<Screen, PermissionCode>> = {
  dashboard: 'dashboard.view',
  shipments: 'shipments.view',
  'create-shipment': 'shipments.create',
  'shipment-detail': 'shipments.view',
  customers: 'customers.view',
  'packing-list': 'packing.view',
  'scan-item': 'packing.view',
  storage: 'packing.view',
  'item-detail': 'packing.view',
  payments: 'payments.view',
  expenses: 'expenses.view',
  reports: 'reports.view',
  staff: 'staff.view',
  settings: 'settings.view',
}

const SCREEN_TITLES: Partial<Record<Screen, { title: string; eyebrow: string }>> = {
  dashboard: { title: 'Dashboard', eyebrow: 'Operations overview' },
  shipments: { title: 'Shipments', eyebrow: 'All cargo shipments' },
  'create-shipment': { title: 'Create Shipment', eyebrow: 'New cargo entry' },
  'shipment-detail': { title: 'Shipment Details', eyebrow: 'Cargo operations' },
  customers: { title: 'Customers', eyebrow: 'Customer directory' },
  'packing-list': { title: 'Packing Lists', eyebrow: 'Dispatch preparation' },
  'scan-item': { title: 'Scan Item', eyebrow: 'QR operations' },
  storage: { title: 'Storage', eyebrow: 'Warehouse inventory' },
  'item-detail': { title: 'Item Details', eyebrow: 'Cargo item' },
  payments: { title: 'Payments', eyebrow: 'Payment records' },
  expenses: { title: 'Expenses', eyebrow: 'Financial operations' },
  reports: { title: 'Financial Reports', eyebrow: 'Business performance' },
  staff: { title: 'Staff Management', eyebrow: 'Team access' },
  settings: { title: 'Company Settings', eyebrow: 'Configuration' },
}

export default function App() {
  const { isAuthenticated, currentUser, logout, initialized, init } = useAuthStore()
  const { loadAll, dataLoaded } = useAppStore()
  const loadRates = useRatesStore(s => s.loadRates)
  const loadAccounting = useAccountingStore(s => s.loadAccounting)
  const [screen, setScreen] = useLocalStorage<Screen>(`${BRAND.storagePrefix}-screen`, 'dashboard')
  const [activeShipmentId, setActiveShipmentId] = useLocalStorage<string | undefined>(`${BRAND.storagePrefix}-ship-id`, undefined)
  const [activeItemCode, setActiveItemCode] = useLocalStorage<string | undefined>(`${BRAND.storagePrefix}-item-code`, undefined)
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>(`${BRAND.storagePrefix}-sidebar`, false)
  const [docsOpen, setDocsOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [topbarSearch, setTopbarSearch] = useState('')
  const [shipmentsSeed, setShipmentsSeed] = useState<{ query: string; status: ShipmentStatus | ''; nonce: number }>({ query: '', status: '', nonce: 0 })

  // Restore any existing Supabase session on first load.
  useEffect(() => { init() }, [])

  useEffect(() => {
    const itemCode = new URLSearchParams(window.location.search).get('item')
    if (itemCode) {
      setActiveItemCode(itemCode)
      setScreen('item-detail')
    }
  }, [])

  // Only load cargo data once signed in — RLS rejects anonymous reads
  // anyway, and this also means each login always sees the latest data.
  useEffect(() => {
    if (isAuthenticated && !currentUser?.mustChangePassword) {
      loadAll()
      loadRates().catch(error => console.error('[App] load rates failed:', error))
      loadAccounting().catch(error => console.error('[App] load accounting failed:', error))
    }
  }, [isAuthenticated, currentUser?.mustChangePassword])

  function navigate(s: Screen, id?: string) {
    if (s !== 'public-tracking' && new URLSearchParams(window.location.search).has('tracking')) {
      window.history.replaceState({}, '', window.location.pathname)
    }
    setScreen(s)
    setMobileNavOpen(false)
    if (s === 'shipment-detail' && id) setActiveShipmentId(id)
    if (s === 'item-detail' && id) setActiveItemCode(id)
  }

  function goToShipments(opts?: { query?: string; status?: ShipmentStatus | '' }) {
    setShipmentsSeed(current => ({ query: opts?.query ?? '', status: opts?.status ?? '', nonce: current.nonce + 1 }))
    navigate('shipments')
  }

  if (!initialized) {
    return <AppLoading label="Preparing your secure workspace" dark />
  }

  const isPublic = screen === 'public-tracking' || new URLSearchParams(window.location.search).has('tracking')
  if (isPublic) return <><Suspense fallback={<PageLoader />}><PublicTracking shipmentId={activeShipmentId} onNavigate={navigate} /></Suspense><Toaster position="top-right" /></>

  if (!isAuthenticated) return <Login />

  if (currentUser?.mustChangePassword) return <RequiredPasswordChange />

  if (!dataLoaded) {
    return <AppLoading label="Loading cargo operations" />
  }

  const visibleNav = NAV_ITEMS.filter(item => !item.permission || hasPermission(
    currentUser?.role,
    item.permission,
    currentUser?.permissionsMode,
    currentUser?.permissions,
  ))
  const currentScreenPermission = SCREEN_PERMISSIONS[screen]
  const currentScreenAllowed = !currentScreenPermission || hasPermission(
    currentUser?.role,
    currentScreenPermission,
    currentUser?.permissionsMode,
    currentUser?.permissions,
  )
  const initials = currentUser ? currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : 'HX'
  const pageMeta = SCREEN_TITLES[screen] || SCREEN_TITLES.dashboard!

  return (
    <div className="app-shell flex h-[100dvh] min-h-0 overflow-hidden">
      <Toaster position="top-right" toastOptions={{ duration: 3000 }} />

      {mobileNavOpen && <button aria-label="Close navigation backdrop" onClick={() => setMobileNavOpen(false)} className="fixed inset-0 z-30 bg-black/50 lg:hidden" />}

      {/* Sidebar */}
      <aside className={`app-sidebar fixed inset-y-0 left-0 z-40 flex w-[280px] flex-shrink-0 flex-col shadow-2xl transition-all duration-200 lg:relative lg:z-auto lg:translate-x-0 lg:shadow-none ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'} ${sidebarCollapsed ? 'lg:w-[84px]' : 'lg:w-[236px]'}`}>
        {/* Logo */}
        <div className="sidebar-brand-row">
          <div className="flex w-full items-center gap-3 lg:hidden">
            <BrandLogo className="sidebar-logo h-12 flex-1" priority />
            <button onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" className="flex size-11 shrink-0 items-center justify-center rounded-xl text-navy-200 transition-colors hover:bg-white/10 hover:text-white"><CloseIcon /></button>
          </div>
          <div className={`hidden w-full items-center lg:flex ${sidebarCollapsed ? 'justify-center' : 'gap-3'}`}>
            {sidebarCollapsed ? (
              <button onClick={() => setSidebarCollapsed(false)} aria-label="Expand navigation" title="Expand navigation" className="sidebar-logo-button">
                <BrandLogo className="sidebar-logo h-11" priority />
              </button>
            ) : (
              <>
                <BrandLogo className="sidebar-logo h-12 min-w-0 flex-1" priority />
                <button onClick={() => setSidebarCollapsed(true)} aria-label="Collapse navigation" title="Collapse navigation" className="flex size-10 shrink-0 items-center justify-center rounded-xl text-navy-300 transition-colors hover:bg-white/10 hover:text-white"><ChevronLeftIcon /></button>
              </>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {visibleNav.map(item => {
            if (!item.label) return <div key={item.id} className="my-2 mx-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.07)' }} />
            const Icon = item.icon!
            const isActive = screen === item.screen || (item.id === 'shipments' && ['shipment-detail', 'create-shipment'].includes(screen)) || (item.id === 'scan-item' && screen === 'item-detail')
            return (
              <button
                key={item.id}
                onClick={() => item.id === 'shipments' ? goToShipments() : navigate(item.screen)}
                title={sidebarCollapsed ? item.label : undefined}
                className={`sidebar-nav-item group flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-sm transition-all ${isActive ? 'is-active text-white' : 'text-blue-100/70 hover:text-white'}`}
              >
                <span className={`flex-shrink-0 ${isActive ? 'text-cargo-400' : 'text-navy-400 group-hover:text-navy-200'}`}><Icon /></span>
                <span className={`truncate font-medium ${sidebarCollapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
                {isActive && <span className={`ml-auto size-1.5 flex-shrink-0 rounded-full bg-cargo-500 ${sidebarCollapsed ? 'lg:hidden' : ''}`} />}
              </button>
            )
          })}
        </nav>

        {/* User footer */}
        <div className={`border-t border-white/[0.07] px-3 py-3 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
            <div className="flex items-center gap-2.5">
              <button onClick={() => setProfileOpen(true)} aria-label="My Profile" title="My Profile" className="rounded-full">
                <Avatar path={currentUser?.avatarPath} initials={initials} sizeClass="size-7" />
              </button>
              <div className="overflow-hidden flex-1">
                <div className="text-white text-xs font-medium truncate">{currentUser?.name}</div>
                <div className="text-navy-400 text-[10px]">{currentUser?.role}</div>
              </div>
              <button onClick={logout} title="Sign out" className="flex size-11 flex-shrink-0 items-center justify-center rounded-lg text-navy-300 transition-colors hover:bg-white/10 hover:text-white"><LogoutIcon /></button>
            </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="app-main flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="mobile-topbar safe-area-top flex min-h-16 flex-shrink-0 items-center gap-3 px-3 lg:hidden">
          <button onClick={() => setMobileNavOpen(true)} aria-label="Open navigation" className="flex size-11 items-center justify-center rounded-xl border border-slate-200 text-navy-900 hover:bg-slate-50"><MenuIcon /></button>
          <div className="min-w-0 flex-1"><div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#0a84d3]">{pageMeta.eyebrow}</div><div className="truncate text-sm font-bold text-[#142033]">{pageMeta.title}</div></div>
          <button onClick={() => setDocsOpen(true)} aria-label="Open documents" className="flex size-11 items-center justify-center rounded-xl border border-slate-200 text-navy-900"><FolderOpenIcon /></button>
          <button onClick={() => setProfileOpen(true)} aria-label="My Profile" title="My Profile" className="rounded-full">
            <Avatar path={currentUser?.avatarPath} initials={initials} sizeClass="size-9" />
          </button>
        </header>
        {/* Top header */}
        <header className="desktop-topbar hidden min-h-[72px] flex-shrink-0 items-center gap-5 px-6 lg:flex">
          <div className="min-w-44">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#0a84d3]">{pageMeta.eyebrow}</div>
            <div className="mt-0.5 text-lg font-bold text-[#142033]">{pageMeta.title}</div>
          </div>
          <div className="flex-1">
            <form className="relative max-w-sm" onSubmit={event => { event.preventDefault(); goToShipments({ query: topbarSearch }) }}>
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input value={topbarSearch} onChange={event => setTopbarSearch(event.target.value)} placeholder="Search tracking # or customer…" aria-label="Search tracking number or customer" className="topbar-search w-full rounded-xl py-2 pl-9 pr-3 text-sm placeholder:text-slate-400" />
            </form>
          </div>
          <button onClick={() => setDocsOpen(true)} className="flex items-center gap-1.5 text-xs font-medium border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50 transition-colors" style={{ color: 'rgb(12,28,53)' }}>
            <FolderOpenIcon /> Documents
          </button>
          <button onClick={() => navigate('public-tracking')} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50 transition-colors">
            <ExternalIcon /> Public Portal
          </button>
          <div className="h-5 w-px bg-slate-200" />
          <div className="flex items-center gap-2">
            <div className="text-right">
              <div className="text-xs font-semibold text-slate-800">{currentUser?.name}</div>
              <div className="text-[10px] text-slate-400">{currentUser?.role}</div>
            </div>
            <button onClick={() => setProfileOpen(true)} aria-label="My Profile" title="My Profile" className="rounded-full">
              <Avatar path={currentUser?.avatarPath} initials={initials} sizeClass="size-9" />
            </button>
            <button onClick={logout} title="Sign out" className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"><LogoutIcon /></button>
          </div>
        </header>

        {/* Page content */}
        <main className="app-content min-h-0 flex-1 overflow-auto overscroll-contain">
          <Suspense fallback={<PageLoader />}>
          {!currentScreenAllowed ? <RouteAccessDenied onDashboard={() => navigate('dashboard')} /> : <>{screen === 'dashboard' && <Dashboard onNavigate={navigate} onViewShipmentsByStatus={status => goToShipments({ status })} />}
          {screen === 'shipments' && <Shipments key={shipmentsSeed.nonce} onNavigate={navigate} initialQuery={shipmentsSeed.query} initialStatus={shipmentsSeed.status} />}
          {screen === 'create-shipment' && <CreateShipment onNavigate={navigate} />}
          {screen === 'shipment-detail' && <ShipmentDetail shipmentId={activeShipmentId || ''} onNavigate={navigate} />}
          {screen === 'packing-list' && <PackingList onNavigate={navigate} />}
          {screen === 'scan-item' && <ScanItem onNavigate={navigate} />}
          {screen === 'item-detail' && <ItemDetails itemCode={activeItemCode || ''} onNavigate={navigate} />}
          {screen === 'customers' && <Customers onNavigate={navigate} />}
          {screen === 'storage' && <Storage onNavigate={navigate} />}
          {screen === 'payments' && <Payments onNavigate={navigate} />}
          {screen === 'expenses' && <Expenses onNavigate={navigate} />}
          {screen === 'settings' && <Settings onNavigate={navigate} />}
          {screen === 'staff' && <StaffRoles onNavigate={navigate} />}
          {screen === 'reports' && <FinancialReports />}</>}
          </Suspense>
        </main>
      </div>

      <DocumentsDrawer open={docsOpen} onClose={() => setDocsOpen(false)} />
      <MyProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </div>
  )
}

function ReportsPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8 bg-slate-50">
      <div className="size-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
        <ChartIcon className="size-7 text-slate-300" />
      </div>
      <div className="text-slate-700 font-semibold">Financial Reports</div>
      <div className="text-slate-400 text-sm mt-1">Coming soon — revenue analytics and export tools.</div>
    </div>
  )
}

function RouteAccessDenied({ onDashboard }: { onDashboard: () => void }) {
  return <div className="flex min-h-full items-center justify-center p-6"><div className="max-w-md rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center"><div className="text-3xl">🔒</div><h1 className="mt-3 font-bold text-slate-900">Access restricted</h1><p className="mt-2 text-sm text-slate-600">Your current role does not have permission to open this area.</p><button onClick={onDashboard} className="primary-button mt-5">Return to Dashboard</button></div></div>
}

function PageLoader() {
  return <div className="flex min-h-64 items-center justify-center p-6"><div className="loading-state"><span className="brand-spinner" /><span>Loading page</span></div></div>
}

function AppLoading({ label, dark = false }: { label: string; dark?: boolean }) {
  return <div className={`app-loading-screen ${dark ? 'is-dark' : ''}`}><div className="app-loading-mark"><BrandLogo className="h-16" priority /></div><div className="loading-state"><span className="brand-spinner" /><span>{label}</span></div></div>
}

// Icons
function GridIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" strokeWidth="2" /><rect x="14" y="3" width="7" height="7" rx="1" strokeWidth="2" fill="rgb(12,15,56)" /><rect x="3" y="14" width="7" height="7" rx="1" strokeWidth="2" /><rect x="14" y="14" width="7" height="7" rx="1" strokeWidth="2" /></svg>
}
function BoxIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
}
function UsersIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
}
function ListIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
}
function QrScanIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7V5a1 1 0 011-1h2m10 0h2a1 1 0 011 1v2M4 17v2a1 1 0 001 1h2m10 0h2a1 1 0 001-1v-2M8 8h3v3H8V8zm5 0h3v3h-3V8zm-5 5h3v3H8v-3zm5 0h1m2 0h1v3h-3v-1" /></svg>
}
function WarehouseIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21V10l9-6 9 6v11M3 21h18M9 21v-6a3 3 0 016 0v6" /></svg>
}
function ReceiptIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
}
function WalletIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
}
function ChartIcon({ className }: { className?: string }) {
  return <svg className={className || 'size-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
}
function ShieldIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
}
function CogIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
}
function ChevronLeftIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
}
function ExternalIcon() {
  return <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
}
function LogoutIcon() {
  return <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
}
function MenuIcon() {
  return <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
}
function CloseIcon() {
  return <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
}
