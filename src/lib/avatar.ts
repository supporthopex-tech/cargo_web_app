import { supabase } from './supabase.ts'

// Client-side mirror of the bucket-level constraints enforced by Supabase
// Storage itself (allowed_mime_types / file_size_limit on the
// staff-profile-images bucket — see
// supabase/migrations/20260817190000_staff_profile_pictures.sql). This is
// a fast-fail convenience only: the real gate is server-side, so a bypassed
// or stale client check can never actually store an oversized or
// wrong-typed file.
export const AVATAR_BUCKET = 'staff-profile-images'
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export function avatarValidationError(file: File): string | null {
  if (!(file.type in AVATAR_ALLOWED_TYPES)) return 'Use a JPG, PNG or WEBP image.'
  if (file.size <= 0) return 'That file is empty.'
  if (file.size > AVATAR_MAX_BYTES) return 'Image must be 2MB or smaller.'
  return null
}

// The bucket is private, so every read is a signed URL — cache them in
// memory (never persisted) for their lifetime minus a safety margin, so
// re-rendering the same avatar elsewhere in the app doesn't re-request a
// URL every time.
const SIGNED_URL_TTL_SECONDS = 3600
const SIGNED_URL_SAFETY_MARGIN_SECONDS = 120
const urlCache = new Map<string, { url: string; expiresAt: number }>()

export async function getAvatarUrl(path: string | undefined | null): Promise<string | null> {
  if (!path) return null
  const cached = urlCache.get(path)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  const { data, error } = await supabase.storage.from(AVATAR_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) return null
  urlCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + (SIGNED_URL_TTL_SECONDS - SIGNED_URL_SAFETY_MARGIN_SECONDS) * 1000,
  })
  return data.signedUrl
}

function clearAvatarUrlCache(path: string) {
  urlCache.delete(path)
}

async function removeAllFilesForUser(userId: string): Promise<void> {
  const { data: existing } = await supabase.storage.from(AVATAR_BUCKET).list(userId)
  if (!existing?.length) return
  const paths = existing.map(entry => `${userId}/${entry.name}`)
  await supabase.storage.from(AVATAR_BUCKET).remove(paths)
  paths.forEach(clearAvatarUrlCache)
}

// Uploads (or replaces) userId's profile photo and returns the storage path
// to persist on staff_profiles.avatar_path. Any previously-stored file for
// this user is removed first — the path includes the extension
// ("{userId}/profile.jpg"), so switching from a PNG to a JPG would
// otherwise leave the old PNG behind as an orphaned object.
export async function uploadAvatarFile(userId: string, file: File): Promise<string> {
  const validationError = avatarValidationError(file)
  if (validationError) throw new Error(validationError)

  const ext = AVATAR_ALLOWED_TYPES[file.type]
  const path = `${userId}/profile.${ext}`

  await removeAllFilesForUser(userId)

  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type,
    cacheControl: '3600',
  })
  if (error) throw new Error(error.message)

  clearAvatarUrlCache(path)
  return path
}

export async function removeAvatarFile(userId: string): Promise<void> {
  await removeAllFilesForUser(userId)
}
