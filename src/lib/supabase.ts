import { createClient } from '@supabase/supabase-js'
import { BRAND } from '../config/brand.ts'

// Single shared Supabase client for the whole app. Uses the publishable
// key only — this file runs in the browser, so it must never hold the
// service_role key. Row Level Security (see supabase/migrations) is what
// actually protects the data: every table grants access to the
// `authenticated` role only, so this key is useless without a signed-in
// session.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const supabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey)

if (!supabaseConfigured) {
  // Fail loudly in development rather than silently no-op-ing every query.
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set — ' +
    'copy .env.example to .env.local and fill them in.'
  )
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabasePublishableKey || 'placeholder-key',
  {
    auth: {
      storageKey: `${BRAND.storagePrefix}-auth`,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  }
)
