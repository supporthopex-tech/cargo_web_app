import { BRAND } from '../config/brand.ts'

/**
 * Generates sequential IDs in the format HOPEX-YYMMDD-XXXX
 * The counter is per day and resets the next day.
 */

function todayPrefix(): string {
  const d = new Date()
  const yy = String(d.getFullYear()).slice(2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

function getCounter(key: string): number {
  const today = todayPrefix()
  const stored = localStorage.getItem(key)
  if (!stored) return 0
  const { date, count } = JSON.parse(stored)
  if (date !== today) return 0
  return count
}

function setCounter(key: string, count: number): void {
  localStorage.setItem(key, JSON.stringify({ date: todayPrefix(), count }))
}

export function nextTrackingNumber(existingNumbers: string[], trackingPrefix: string = BRAND.code): string {
  const today = todayPrefix()
  const prefix = `${trackingPrefix.trim() || BRAND.code}-${today}-`
  const existing = existingNumbers
    .filter(n => n.startsWith(prefix))
    .map(n => parseInt(n.replace(prefix, ''), 10))
    .filter(n => !isNaN(n))
  const max = existing.length > 0 ? Math.max(...existing) : 0
  const next = max + 1
  return `${prefix}${String(next).padStart(4, '0')}`
}

export function nextReceiptNumber(existingNumbers: string[]): string {
  const today = todayPrefix()
  const prefix = `RCT-${today}-`
  const existing = existingNumbers
    .filter(n => n.startsWith(prefix))
    .map(n => parseInt(n.replace(prefix, ''), 10))
    .filter(n => !isNaN(n))
  const max = existing.length > 0 ? Math.max(...existing) : 0
  const next = max + 1
  return `${prefix}${String(next).padStart(4, '0')}`
}

export function nextPackingListNumber(existingNumbers: string[], packingListPrefix: string = `PL-${BRAND.code}`): string {
  const today = todayPrefix()
  const prefix = `${packingListPrefix.trim() || `PL-${BRAND.code}`}-${today}-`
  const existing = existingNumbers
    .filter(n => n.startsWith(prefix))
    .map(n => parseInt(n.replace(prefix, ''), 10))
    .filter(n => !isNaN(n))
  const max = existing.length > 0 ? Math.max(...existing) : 0
  const next = max + 1
  return `${prefix}${String(next).padStart(3, '0')}`
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function nowISO(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ')
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}
