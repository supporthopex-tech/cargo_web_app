import { useMemo, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import toast from 'react-hot-toast'
import type { Screen } from '../App'
import Modal from '../components/Modal'
import { itemQrUrl, printItemStickers } from '../lib/itemStickers'
import { allocatedQuantity, availableQuantity, findItemContext, formatPackingQuantity } from '../lib/packing'
import { useAppStore } from '../store/useAppStore'

interface Props { itemCode: string; onNavigate: (screen: Screen, id?: string) => void }

export default function ItemDetails({ itemCode, onNavigate }: Props) {
  const { shipments, customers, packingLists, packingBoxes, packingAllocations, settings, upsertPackingAllocation } = useAppStore()
  const context = useMemo(() => findItemContext(itemCode, shipments, customers), [itemCode, shipments, customers])
  const [copies, setCopies] = useState(1)
  const [packModal, setPackModal] = useState(false)
  const draftLists = packingLists.filter(list => list.status === 'Draft')
  const [packingListId, setPackingListId] = useState(draftLists[0]?.id || '')
  const boxes = packingBoxes.filter(box => box.packingListId === packingListId)
  const [boxId, setBoxId] = useState('')
  const [quantity, setQuantity] = useState('')
  const selectedBoxId = boxes.some(box => box.id === boxId) ? boxId : boxes[0]?.id || ''

  if (!context) return <div className="app-page flex items-center justify-center"><div className="premium-card max-w-sm p-6 text-center"><h1 className="font-semibold text-slate-800">Item not found</h1><p className="text-sm text-slate-500 mt-1">Check the Item Code or scan the sticker again.</p><button onClick={() => onNavigate('scan-item')} className="primary-button mt-4">Scan Another Item</button></div></div>

  const { item, shipment, customer } = context
  const allocated = allocatedQuantity(item.id, packingAllocations, packingLists)
  const available = availableQuantity(item, packingAllocations, packingLists)
  const displayCustomer = customer?.company || customer?.name || shipment.customerNameSnapshot || '—'
  const itemBoxAllocations = useMemo(() => {
    const activeListIds = new Set(packingLists.filter(list => list.status === 'Draft' || list.status === 'Closed' || list.status === 'Dispatched').map(list => list.id))
    return packingAllocations
      .filter(allocation => allocation.shipmentItemId === item.id && activeListIds.has(allocation.packingListId))
      .map(allocation => {
        const box = packingBoxes.find(candidate => candidate.id === allocation.boxId)
        const list = packingLists.find(candidate => candidate.id === allocation.packingListId)
        return { allocation, box, list }
      })
      .filter((entry): entry is { allocation: typeof entry.allocation; box: NonNullable<typeof entry.box>; list: NonNullable<typeof entry.list> } => Boolean(entry.box && entry.list))
      .sort((a, b) => a.list.listId.localeCompare(b.list.listId) || a.box.boxNumber - b.box.boxNumber)
  }, [item.id, packingAllocations, packingLists, packingBoxes])

  function printSticker() {
    const opened = printItemStickers([{ item, shipment, customer, copies }], settings)
    opened ? toast.success(`${copies} sticker${copies === 1 ? '' : 's'} prepared.`) : toast.error('The print window was blocked. Allow pop-ups and try again.')
  }

  async function addToBox() {
    const amount = Number(quantity)
    if (!item.id || !selectedBoxId || amount <= 0) { toast.error('Choose a box and enter a positive quantity.'); return }
    try {
      await upsertPackingAllocation(selectedBoxId, item.id, amount, 'ADD')
      toast.success(`${formatPackingQuantity(amount)} ${item.unit} added to the box.`)
      setQuantity('')
      setPackModal(false)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Item could not be added to the box.') }
  }

  return (
    <div className="app-page">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center gap-3"><button onClick={() => onNavigate('scan-item')} className="secondary-button">Back</button><div><h1 className="text-xl font-bold text-slate-800">Item Details</h1><p className="text-xs text-slate-500">Hopex Express Cargo item identity</p></div></div>
        <div className="section-surface grid gap-5 p-4 sm:p-5 md:grid-cols-[230px_1fr]">
          <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-4"><QRCodeSVG value={itemQrUrl(item.itemCode || itemCode)} size={190} level="H" marginSize={2} /><div className="mt-3 font-mono text-sm font-bold">{item.itemCode}</div></div>
          <div>
            <div className="text-xs font-bold tracking-[0.2em] text-orange-600">HOPEX EXPRESS CARGO</div>
            <h2 className="mt-1 break-words text-xl font-bold text-slate-900 sm:text-2xl">{item.description}</h2>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <Detail label="Customer" value={displayCustomer} /><Detail label="Tracking Number" value={shipment.trackingNumber} />
              <Detail label="Shipping Method" value={shipment.shipmentType.toUpperCase()} /><Detail label="Shipment Status" value={shipment.status} />
            </div>
            <div className="mt-5 grid gap-2 sm:grid-cols-3">
              <QuantityCard label="Shipment Quantity" value={item.quantity} unit={item.unit} tone="slate" />
              <QuantityCard label="Allocated" value={allocated} unit={item.unit} tone="amber" />
              <QuantityCard label="Available" value={available} unit={item.unit} tone="green" />
            </div>
            {itemBoxAllocations.length > 0 && (
              <div className="mt-5">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Boxes Containing This Item</div>
                <div className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                  {itemBoxAllocations.map(({ allocation, box, list }) => (
                    <div key={allocation.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div>
                        <span className="font-mono font-semibold text-slate-800">BOX {String(box.boxNumber).padStart(3, '0')}</span>
                        <span className="ml-2 text-xs text-slate-400">{list.listId} · {list.status}</span>
                      </div>
                      <div className="font-semibold text-slate-700">{formatPackingQuantity(allocation.quantity)} {item.unit}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-5 grid gap-2 sm:grid-cols-3"><button onClick={() => onNavigate('shipment-detail', shipment.id)} className="secondary-button min-h-11">View Shipment</button><button onClick={printSticker} className="secondary-button min-h-11">Print Sticker</button><button disabled={!draftLists.length || available <= 0} onClick={() => setPackModal(true)} className="primary-button min-h-11 disabled:opacity-50">Add to Packing List</button></div>
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-500">Sticker copies <input type="number" min="1" max="100" value={copies} onChange={event => setCopies(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} className="w-20 rounded-lg border border-slate-200 px-2 py-1" /></label>
          </div>
        </div>
      </div>

      <Modal open={packModal} onClose={() => setPackModal(false)} title="Add Item to Packing List">
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 p-3 text-sm"><div className="font-semibold text-slate-800">{item.description}</div><div className="text-xs text-slate-500">Available: {formatPackingQuantity(available)} {item.unit}</div></div>
          <label className="block"><span className="form-label">Packing List</span><select value={packingListId} onChange={event => { setPackingListId(event.target.value); setBoxId('') }} className="form-input">{draftLists.map(list => <option key={list.id} value={list.id}>{list.listId}</option>)}</select></label>
          <label className="block"><span className="form-label">Box</span><select value={selectedBoxId} onChange={event => setBoxId(event.target.value)} className="form-input">{boxes.map(box => <option key={box.id} value={box.id}>BOX {String(box.boxNumber).padStart(3, '0')}</option>)}</select></label>
          <label className="block"><span className="form-label">Quantity in This Box</span><input type="number" min="0.001" step="0.001" max={available} value={quantity} onChange={event => setQuantity(event.target.value)} className="form-input" /></label>
          <div className="flex gap-2"><button onClick={() => setPackModal(false)} className="secondary-button flex-1">Cancel</button><button onClick={addToBox} className="primary-button flex-1">Add to Box</button></div>
        </div>
      </Modal>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) { return <div><div className="text-xs text-slate-400">{label}</div><div className="font-semibold text-slate-700">{value}</div></div> }
function QuantityCard({ label, value, unit, tone }: { label: string; value: number; unit: string; tone: 'slate' | 'amber' | 'green' }) { const classes = tone === 'green' ? 'bg-emerald-50 text-emerald-800' : tone === 'amber' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-800'; return <div className={`rounded-xl p-3 ${classes}`}><div className="text-[10px] font-semibold uppercase">{label}</div><div className="mt-1 font-bold">{formatPackingQuantity(value)} <span className="text-xs">{unit}</span></div></div> }
