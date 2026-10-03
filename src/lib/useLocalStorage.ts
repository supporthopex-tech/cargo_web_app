import { useState } from 'react'

export function useLocalStorage<T>(key: string, initialValue: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [stored, setStored] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key)
      return item ? JSON.parse(item) : initialValue
    } catch {
      return initialValue
    }
  })

  function setValue(value: T | ((prev: T) => T)) {
    const toStore = value instanceof Function ? value(stored) : value
    setStored(toStore)
    try { localStorage.setItem(key, JSON.stringify(toStore)) } catch {}
  }

  return [stored, setValue]
}
