import { useEffect, useState } from 'react'
import { getAvatarUrl } from '../lib/avatar.ts'

interface Props {
  path?: string
  initials: string
  sizeClass?: string
  className?: string
}

// Resolves a private-bucket storage path to a signed URL on demand and
// falls back to the initials circle already used everywhere in this app
// (sidebar, topbar, Staff Management) while loading or when no photo is
// set — the fallback is never a broken-image icon.
export default function Avatar({ path, initials, sizeClass = 'size-9', className = '' }: Props) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    if (path) {
      getAvatarUrl(path).then(resolved => { if (!cancelled) setUrl(resolved) })
    }
    return () => { cancelled = true }
  }, [path])

  if (url) {
    return <img src={url} alt="" className={`${sizeClass} shrink-0 rounded-full object-cover ${className}`} />
  }
  return (
    <div className={`avatar-ring flex ${sizeClass} shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${className}`}>
      {initials}
    </div>
  )
}
