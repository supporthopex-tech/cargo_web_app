import { create } from 'zustand'
import type { PermissionMode, User, UserRole } from '../types'
import { supabase } from '../lib/supabase'
import { removeAvatarFile, uploadAvatarFile } from '../lib/avatar.ts'
import { hasPermission, type PermissionCode } from '../lib/permissions'

interface StaffProfileRow {
  id: string
  email: string
  username: string
  phone: string
  name: string
  initials: string
  role: UserRole | 'Operations Staff'
  active: boolean
  must_change_password: boolean
  avatar_path: string | null
  last_login_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string | null
  permissions_mode?: PermissionMode
  permissions?: string[]
}

export interface CreateStaffInput {
  name: string
  username: string
  email: string
  phone: string
  role: string
  password: string
  mustChangePassword: boolean
  active: boolean
  permissionsMode?: PermissionMode
  permissions?: string[]
}

export interface UpdateStaffInput {
  name: string
  username: string
  email: string
  phone: string
  role: UserRole
  permissionsMode?: PermissionMode
  permissions?: string[]
}

function mapProfile(row: StaffProfileRow): User {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    phone: row.phone || '',
    name: row.name,
    initials: row.initials,
    role: row.role === 'Operations Staff' ? 'Staff' : row.role as UserRole,
    active: row.active,
    mustChangePassword: row.must_change_password,
    avatarPath: row.avatar_path || undefined,
    lastLoginAt: row.last_login_at || undefined,
    createdBy: row.created_by || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at || undefined,
    permissionsMode: row.permissions_mode || 'ROLE_DEFAULT',
    permissions: row.permissions || [],
  }
}

async function fetchProfile(userId: string): Promise<User | null> {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('id,email,username,phone,name,initials,role,active,must_change_password,avatar_path,last_login_at,created_by,created_at,updated_at,permissions_mode,permissions')
    .eq('id', userId)
    .maybeSingle()
  if (error || !data) return null
  return mapProfile(data as StaffProfileRow)
}

async function functionError(error: unknown, data: unknown, fallback: string): Promise<Error> {
  if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
    return new Error(data.error)
  }
  const context = error && typeof error === 'object' && 'context' in error ? error.context : null
  if (context instanceof Response) {
    try {
      const payload = await context.clone().json()
      if (payload?.error) return new Error(payload.error)
    } catch {
      // Keep the safe fallback below when the server returned a non-JSON body.
    }
  }
  return new Error(fallback)
}

async function invokeStaffAdmin(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('staff-admin', { body })
  if (error) throw await functionError(error, data, 'The staff request could not be completed.')
  return (data || {}) as Record<string, unknown>
}

interface AuthState {
  users: User[]
  currentUser: User | null
  isAuthenticated: boolean
  initialized: boolean

  init: () => Promise<void>
  login: (identifier: string, password: string) => Promise<{ success: boolean; error?: string }>
  logout: () => Promise<void>
  requestPasswordReset: (identifier: string) => Promise<void>
  completePasswordChange: (newPassword: string) => Promise<void>
  loadUsers: () => Promise<void>
  addUser: (data: CreateStaffInput) => Promise<User>
  updateUser: (id: string, data: UpdateStaffInput) => Promise<void>
  resetPassword: (id: string, password: string, mustChangePassword: boolean) => Promise<void>
  setUserStatus: (id: string, active: boolean) => Promise<void>
  deleteUser: (id: string) => Promise<void>

  // Profile photo. Self-service for any active staff role (their own id)
  // or Admin-managed (any id) — enforced by both the staff_profiles RLS
  // policies and, independently, the staff-profile-images Storage bucket's
  // own RLS (see supabase/migrations/20260817190000_staff_profile_pictures.sql).
  uploadAvatar: (userId: string, file: File) => Promise<void>
  removeAvatar: (userId: string) => Promise<void>
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  users: [],
  currentUser: null,
  isAuthenticated: false,
  initialized: false,

  init: async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user) {
      const profile = await fetchProfile(session.user.id)
      if (profile?.active) set({ currentUser: profile, isAuthenticated: true })
      else await supabase.auth.signOut({ scope: 'local' })
    }
    set({ initialized: true })

    supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!session?.user) {
        set({ currentUser: null, isAuthenticated: false })
        return
      }
      const profile = await fetchProfile(session.user.id)
      set(profile?.active
        ? { currentUser: profile, isAuthenticated: true }
        : { currentUser: null, isAuthenticated: false })
    })
  },

  login: async (identifier, password) => {
    const { data, error } = await supabase.functions.invoke('staff-login', {
      body: { identifier: identifier.trim(), password },
    })
    if (error || !data?.access_token || !data?.refresh_token) {
      const safeError = await functionError(error, data, 'Invalid email/username or password.')
      return { success: false, error: safeError.message }
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    })
    if (sessionError || !sessionData.user) {
      return { success: false, error: 'Unable to start your session. Please try again.' }
    }

    const profile = await fetchProfile(sessionData.user.id)
    if (!profile?.active) {
      await supabase.auth.signOut({ scope: 'local' })
      return { success: false, error: 'Your account is disabled. Please contact your administrator.' }
    }
    set({ currentUser: profile, isAuthenticated: true })
    return { success: true }
  },

  logout: async () => {
    await supabase.auth.signOut({ scope: 'local' })
    set({ currentUser: null, isAuthenticated: false, users: [] })
  },

  requestPasswordReset: async (identifier) => {
    const { data, error } = await supabase.functions.invoke('staff-login', {
      body: { action: 'request-reset', identifier: identifier.trim() },
    })
    if (error) throw await functionError(error, data, 'Password reset could not be requested.')
  },

  completePasswordChange: async (newPassword) => {
    const { data, error } = await supabase.functions.invoke('complete-password-change', {
      body: { password: newPassword },
    })
    if (error) throw await functionError(error, data, 'Password could not be changed.')
    const userId = get().currentUser?.id
    if (!userId) throw new Error('Your session has expired. Please sign in again.')
    const profile = await fetchProfile(userId)
    if (!profile) throw new Error('Your staff profile could not be refreshed.')
    set({ currentUser: profile })
  },

  loadUsers: async () => {
    const { data, error } = await supabase
      .from('staff_profiles')
      .select('id,email,username,phone,name,initials,role,active,must_change_password,avatar_path,last_login_at,created_by,created_at,updated_at,permissions_mode,permissions')
      .order('created_at')
    if (error) throw new Error(error.message)
    set({ users: (data as StaffProfileRow[]).map(mapProfile) })
  },

  addUser: async (input) => {
    const result = await invokeStaffAdmin({ action: 'create', ...input })
    await get().loadUsers()
    const created = get().users.find(user => user.id === result.staffId)
    if (!created) throw new Error('Staff was created, but the list could not be refreshed.')
    return created
  },

  updateUser: async (id, input) => {
    await invokeStaffAdmin({ action: 'update', staffId: id, ...input })
    await get().loadUsers()
  },

  resetPassword: async (id, password, mustChangePassword) => {
    await invokeStaffAdmin({ action: 'reset-password', staffId: id, password, mustChangePassword })
    await get().loadUsers()
  },

  setUserStatus: async (id, active) => {
    await invokeStaffAdmin({ action: 'set-status', staffId: id, active })
    await get().loadUsers()
  },

  deleteUser: async () => {
    throw new Error('Staff accounts with business history are retained. Disable the account instead.')
  },

  uploadAvatar: async (userId, file) => {
    const path = await uploadAvatarFile(userId, file)
    const { error } = await supabase.from('staff_profiles').update({ avatar_path: path }).eq('id', userId).select().single()
    if (error) throw new Error(error.message)
    set(s => ({
      users: s.users.map(user => user.id === userId ? { ...user, avatarPath: path } : user),
      currentUser: s.currentUser?.id === userId ? { ...s.currentUser, avatarPath: path } : s.currentUser,
    }))
  },

  removeAvatar: async (userId) => {
    await removeAvatarFile(userId)
    const { error } = await supabase.from('staff_profiles').update({ avatar_path: null }).eq('id', userId).select().single()
    if (error) throw new Error(error.message)
    set(s => ({
      users: s.users.map(user => user.id === userId ? { ...user, avatarPath: undefined } : user),
      currentUser: s.currentUser?.id === userId ? { ...s.currentUser, avatarPath: undefined } : s.currentUser,
    }))
  },
}))

const FEATURE_PERMISSIONS: Record<string, PermissionCode> = {
  staff: 'staff.view',
  settings: 'settings.view',
  expenses: 'expenses.view',
  reports: 'reports.view',
  'customer.delete': 'customers.delete',
  'customer.archive': 'customers.delete',
  'shipment.delete': 'shipments.delete',
  'shipment.void': 'shipments.delete',
  'payment.refund': 'payments.create',
  'shipment.rate_override': 'shipments.edit',
  'shipping_rates.manage': 'settings.edit',
  'exchange_rates.manage': 'settings.edit',
  'invoice.edit': 'invoices.edit',
  extra_charges: 'shipments.extra_charges',
}

export function canAccess(
  role: UserRole | undefined,
  feature: string,
  permissionsMode: PermissionMode = 'ROLE_DEFAULT',
  permissions: readonly string[] = [],
): boolean {
  const permission = FEATURE_PERMISSIONS[feature]
  if (!permission) return Boolean(role)
  return hasPermission(role, permission, permissionsMode, permissions)
}
