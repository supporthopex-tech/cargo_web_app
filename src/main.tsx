import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Registers the app-shell-only service worker (public/sw.js) so the installed
// PWA still opens offline/on a poor connection. Production builds only — in
// dev, a cached service worker would fight Vite's own module reloading.
// Business data is never cached; see sw.js for the exact scope.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Installability/offline shell is a progressive enhancement — a failed
      // registration must never block the app itself from working.
    })
  })
}
