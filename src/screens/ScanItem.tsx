import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import type { Screen } from '../App'
import ItemQrScanner from '../components/ItemQrScanner'
import PageHeader from '../components/PageHeader'
import { allocatedQuantity, availableQuantity, findItemContext, formatPackingQuantity, searchItemContexts } from '../lib/packing'
import { useAppStore } from '../store/useAppStore'

interface Props { onNavigate: (screen: Screen, id?: string) => void }

export default function ScanItem({ onNavigate }: Props) {
  const { shipments, customers, packingLists, packingAllocations } = useAppStore()
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchItemContexts(query, shipments, customers).slice(0, 20), [query, shipments, customers])

  function handleCode(value: string) {
    const exact = findItemContext(value, shipments, customers)
    if (exact?.item.itemCode) { onNavigate('item-detail', exact.item.itemCode); return }
    setQuery(value)
    if (searchItemContexts(value, shipments, customers).length === 0) toast.error(`No cargo item found for "${value}".`)
  }

  return (
    <div className="app-page">
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Scan Item QR" description="Identify cargo and see its Packing List balance." />
        <div className="section-surface p-3 sm:p-4 md:p-5"><ItemQrScanner onCode={handleCode} /></div>
        {query && (
          <section className="section-surface mt-5">
            <div className="border-b bg-slate-50 px-4 py-3"><h2 className="text-sm font-semibold text-slate-700">Search Results</h2></div>
            <div className="divide-y divide-slate-100">
              {results.map(({ item, shipment, customer }) => {
                const allocated = allocatedQuantity(item.id, packingAllocations, packingLists)
                return <button key={item.id || `${shipment.id}-${item.itemNumber}`} onClick={() => item.itemCode && onNavigate('item-detail', item.itemCode)} className="w-full p-4 text-left hover:bg-slate-50 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1"><div className="font-mono text-xs font-bold text-[#0c1c35]">{item.itemCode}</div><div className="font-semibold text-slate-800">{item.description}</div><div className="text-xs text-slate-500">{customer?.company || customer?.name || shipment.customerNameSnapshot} · {shipment.trackingNumber}</div></div>
                  <div className="text-right text-xs"><div className="font-semibold text-slate-700">Original {formatPackingQuantity(item.quantity)} {item.unit}</div><div className="text-amber-700">Allocated {formatPackingQuantity(allocated)}</div><div className="text-emerald-700">Available {formatPackingQuantity(availableQuantity(item, packingAllocations, packingLists))}</div></div>
                </button>
              })}
              {results.length === 0 && <p className="p-6 text-center text-sm text-slate-400">No item matches this search.</p>}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
