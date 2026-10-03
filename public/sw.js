// Hopex Express Cargo — app-shell service worker.
//
// Scope: caches the static app shell (HTML entry point, built JS/CSS bundles,
// icons, manifest) so the installed PWA still opens when offline or on a poor
// connection. Deliberately does NOT cache or intercept anything else — in
// particular it never touches Supabase requests (cross-origin, so they never
// match isAppShellRequest below) or any non-GET request, so shipments,
// invoices, payments, and every other piece of business data always come
// straight from the network. This app is explicitly NOT offline-first for
// data — only the shell is cached.
const SHELL_CACHE = 'hopex-shell-v3'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

function isAppShellRequest(request) {
  if (request.method !== 'GET') return false
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false
  if (request.mode === 'navigate') return true
  return /\.(js|css|png|jpg|jpeg|svg|webp|woff2?|ico|json|webmanifest)$/.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (!isAppShellRequest(request)) return // not ours to handle — browser goes straight to network (Supabase, auth, etc.)

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      })
      .catch(() => caches.match(request).then((cached) => cached || (request.mode === 'navigate' ? caches.match('/index.html') : undefined))),
  )
})
