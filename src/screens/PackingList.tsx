import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import type { Screen } from '../App'
import ConfirmDialog from '../components/ConfirmDialog'
import ItemQrScanner from '../components/ItemQrScanner'
import Modal from '../components/Modal'
import PageHeader from '../components/PageHeader'
import { printPackingList } from '../lib/pdf'
import {
  allocatedQuantity,
  allocationContexts,
  availableQuantity,
  closePackingListBlockers,
  findItemContext,
  formatPackingQuantity,
  searchItemContexts,
  shipmentPackingSummary,
  type PackingState,
  type ShipmentItemContext,
} from '../lib/packing'
import { useAppStore } from '../store/useAppStore'
import { canAccess, useAuthStore } from '../store/useAuthStore'

interface Props { onNavigate: (screen: Screen, id?: string) => void }

export default function PackingList({ onNavigate }: Props) {
  const {
    packingLists, packingBoxes, packingAllocations, shipments, customers, settings,
    addPackingList, deletePackingList, dispatchPackingList, closePackingList, addShipmentToPackingList,
    removeShipmentFromPackingList, createPackingBox, upsertPackingAllocation,
    removePackingAllocation, movePackingAllocation,
  } = useAppStore()
  const currentUser = useAuthStore(state => state.currentUser)

  const [selectedId, setSelectedId] = useState(packingLists[0]?.id || '')
  const [selectedBoxId, setSelectedBoxId] = useState('')
  const [createModal, setCreateModal] = useState(false)
  const [newName, setNewName] = useState('')
  const [addShipModal, setAddShipModal] = useState(false)
  const [addShipSearch, setAddShipSearch] = useState('')
  const [scanModal, setScanModal] = useState(false)
  const [scanQuery, setScanQuery] = useState('')
  const [selectedItem, setSelectedItem] = useState<ShipmentItemContext | null>(null)
  const [packQuantity, setPackQuantity] = useState('')
  const [scanSession, setScanSession] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editQuantity, setEditQuantity] = useState('')
  const [movingId, setMovingId] = useState<string | null>(null)
  const [moveBoxId, setMoveBoxId] = useState('')
  const [moveQuantity, setMoveQuantity] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [dispatchConfirm, setDispatchConfirm] = useState(false)
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [availableQuery, setAvailableQuery] = useState('')

  const pl = packingLists.find(list => list.id === selectedId) || packingLists[0]
  const boxes = packingBoxes.filter(box => box.packingListId === pl?.id).sort((a, b) => a.boxNumber - b.boxNumber)
  const activeBoxId = boxes.some(box => box.id === selectedBoxId) ? selectedBoxId : boxes[0]?.id || ''
  const listShipments = pl ? shipments.filter(shipment => pl.shipmentIds.includes(shipment.id)) : []
  const contexts = pl ? allocationContexts(pl.id, packingBoxes, packingAllocations, shipments, customers) : []
  const boxContexts = contexts.filter(context => context.box.id === activeBoxId)
  const activeBox = boxes.find(box => box.id === activeBoxId)
  const searchResults = useMemo(() => searchItemContexts(scanQuery, shipments, customers).slice(0, 16), [scanQuery, shipments, customers])
  const selectedExisting = selectedItem?.item.id
    ? packingAllocations.find(allocation => allocation.boxId === activeBoxId && allocation.shipmentItemId === selectedItem.item.id)
    : undefined

  const availableToAdd = shipments.filter(shipment =>
    !pl?.shipmentIds.includes(shipment.id)
    && ['RECEIVED', 'PACKED'].includes(shipment.status)
    && (addShipSearch === '' || shipment.trackingNumber.toLowerCase().includes(addShipSearch.toLowerCase())
      || customers.find(customer => customer.id === shipment.customerId)?.company.toLowerCase().includes(addShipSearch.toLowerCase())))

  async function handleCreate() {
    if (!newName.trim()) return
    try {
      const created = await addPackingList({ status: 'Draft', shipmentIds: [], origin: 'Dubai, UAE', destination: 'Tanzania', shipmentType: 'Sea Cargo', notes: newName.trim(), createdBy: currentUser?.name || 'System' })
      setSelectedId(created.id); setSelectedBoxId(''); setCreateModal(false); setNewName('')
      toast.success(`Packing List ${created.listId} created with BOX 001.`)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Packing List could not be created.') }
  }

  async function handleAddBox() {
    if (!pl) return
    try { const box = await createPackingBox(pl.id); setSelectedBoxId(box.id); toast.success(`BOX ${String(box.boxNumber).padStart(3, '0')} created.`) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Box could not be created.') }
  }

  function selectScannedValue(value: string) {
    const exact = findItemContext(value, shipments, customers)
    if (exact) { setSelectedItem(exact); setScanQuery(''); return }
    setSelectedItem(null); setScanQuery(value)
    if (searchItemContexts(value, shipments, customers).length === 0) toast.error(`No cargo item found for "${value}".`)
  }

  async function addSelectedItem() {
    const amount = Number(packQuantity)
    if (!selectedItem?.item.id || !activeBoxId || amount <= 0) { toast.error('Scan an item and enter a positive quantity.'); return }
    try {
      await upsertPackingAllocation(activeBoxId, selectedItem.item.id, amount, 'ADD')
      toast.success(`${formatPackingQuantity(amount)} ${selectedItem.item.unit} added to ${boxLabel(activeBox?.boxNumber)}.`)
      setSelectedItem(null); setScanQuery(''); setPackQuantity(''); setScanSession(session => session + 1)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Item could not be added to the box.') }
  }

  async function saveAllocation(allocationId: string) {
    const allocation = packingAllocations.find(candidate => candidate.id === allocationId)
    const amount = Number(editQuantity)
    if (!allocation || amount <= 0) { toast.error('Enter a positive quantity.'); return }
    try { await upsertPackingAllocation(allocation.boxId, allocation.shipmentItemId, amount, 'SET'); setEditingId(null); toast.success('Box quantity updated.') }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Quantity could not be updated.') }
  }

  async function removeAllocation(allocationId: string) {
    if (!confirm('Remove this item quantity from the box? The original Shipment Item will not change.')) return
    try { await removePackingAllocation(allocationId); toast.success('Item removed from the box.') }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Item could not be removed.') }
  }

  async function moveAllocation() {
    const amount = Number(moveQuantity)
    if (!movingId || !moveBoxId || amount <= 0) { toast.error('Choose a destination box and quantity.'); return }
    try { await movePackingAllocation(movingId, moveBoxId, amount); setMovingId(null); setMoveBoxId(''); setMoveQuantity(''); toast.success('Quantity moved safely between boxes.') }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Quantity could not be moved.') }
  }

  async function handleDispatch() {
    if (!pl) return
    try { await dispatchPackingList(pl.id, currentUser?.name || 'System'); setDispatchConfirm(false); toast.success(`${pl.listId} dispatched and locked.`) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Packing List could not be dispatched.') }
  }

  async function handleClose() {
    if (!pl) return
    try { await closePackingList(pl.id); setCloseConfirm(false); toast.success(`${pl.listId} closed. Its items and quantities are now locked.`) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Packing List could not be closed.') }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try { await deletePackingList(deleteTarget); setSelectedId(packingLists.find(list => list.id !== deleteTarget)?.id || ''); toast.success('Draft Packing List deleted; its allocations were released.') }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Packing List could not be deleted.') }
    setDeleteTarget(null)
  }

  const boxTotals = unitTotals(boxContexts.map(context => ({ quantity: context.allocation.quantity, unit: context.item.unit })))
  const listTotals = unitTotals(contexts.map(context => ({ quantity: context.allocation.quantity, unit: context.item.unit })))
  const closeBlockers = pl ? closePackingListBlockers(pl, packingAllocations, shipments, packingLists) : []
  const canClosePl = Boolean(pl) && pl?.status === 'Draft' && canAccess(currentUser?.role, 'packing.close') && closeBlockers.length === 0

  const availableItems = useMemo(() => {
    const query = availableQuery.trim().toLowerCase()
    return shipments
      .flatMap(shipment => {
        const customer = customers.find(candidate => candidate.id === shipment.customerId)
        return shipment.items.filter(item => item.id).map(item => ({ item, shipment, customer }))
      })
      .filter(entry => !query
        || entry.item.itemCode?.toLowerCase().includes(query)
        || entry.item.description.toLowerCase().includes(query)
        || entry.shipment.trackingNumber.toLowerCase().includes(query)
        || entry.customer?.company.toLowerCase().includes(query)
        || entry.customer?.name.toLowerCase().includes(query))
      .map(entry => ({
        ...entry,
        packed: allocatedQuantity(entry.item.id, packingAllocations, packingLists),
        remaining: availableQuantity(entry.item, packingAllocations, packingLists),
      }))
      .filter(entry => entry.remaining > 0)
      .sort((a, b) => a.shipment.trackingNumber.localeCompare(b.shipment.trackingNumber) || a.item.itemNumber - b.item.itemNumber)
  }, [availableQuery, shipments, customers, packingAllocations, packingLists])

  function packFromAvailableItems(entry: ShipmentItemContext) {
    if (!activeBoxId) { toast.error('Create or select a box first.'); return }
    setSelectedItem(entry); setScanQuery(''); setPackQuantity(''); setScanModal(true)
  }

  // Items on this Packing List's shipments that still have quantity left to
  // pack — shown as a warning table before Dispatch, not a hard block.
  // Dispatching a Packing List no longer forces its shipments to PACKED
  // (see dispatch_packing_list_with_status() in
  // 20260819130000_partial_packing_dispatch.sql), so partially-packed
  // shipments are a normal, expected case here, not an error state.
  const dispatchRemainingItems = useMemo(() => (
    listShipments
      .flatMap(shipment => {
        const customer = customers.find(candidate => candidate.id === shipment.customerId)
        return shipment.items.filter(item => item.id).map(item => ({
          item, shipment, customer,
          packed: allocatedQuantity(item.id, packingAllocations, packingLists),
          remaining: availableQuantity(item, packingAllocations, packingLists),
        }))
      })
      .filter(entry => entry.remaining > 0)
  ), [listShipments, customers, packingAllocations, packingLists])

  return (
    <div className="app-page">
      <PageHeader title="Packing List Manager" description="Scan shipment items into boxes without changing original quantities." action={<button onClick={() => setCreateModal(true)} className="primary-button gap-2"><PlusIcon /> New Packing List</button>} />

      <div className="flex gap-2 mb-5 overflow-x-auto pb-1">{packingLists.map(list => <button key={list.id} onClick={() => { setSelectedId(list.id); setSelectedBoxId('') }} className={`whitespace-nowrap rounded-xl border px-4 py-2.5 text-sm font-semibold ${pl?.id === list.id ? 'border-[#0c1c35] bg-[#0c1c35] text-white' : 'border-slate-200 bg-white text-slate-600'}`}><span className="font-mono text-xs">{list.listId}</span><span className="ml-2 text-[10px] opacity-75">{list.status}</span></button>)}{!packingLists.length && <p className="text-sm text-slate-400">No Packing Lists yet.</p>}</div>

      {pl && <div className="space-y-4">
        <section className="section-surface">
          <header className="flex flex-wrap items-center gap-3 border-b bg-slate-50 px-4 py-3 md:px-5">
            <div className="min-w-0">
              <div className="font-mono text-sm font-bold text-slate-800">{pl.listId}</div>
              <div className="break-words text-xs text-slate-500">Created {pl.createdAt} by {pl.createdBy}</div>
              {pl.status === 'Closed' && <div className="break-words text-xs text-blue-600">Closed {pl.closedAt} by {pl.closedBy}</div>}
              {pl.status === 'Dispatched' && pl.dispatchedAt && <div className="break-words text-xs text-emerald-600">Dispatched {pl.dispatchedAt}</div>}
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${pl.status === 'Dispatched' ? 'bg-emerald-100 text-emerald-700' : pl.status === 'Closed' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>{pl.status.toUpperCase()}</span>
            <div className="grid w-full grid-cols-2 gap-2 md:ml-auto md:flex md:w-auto md:flex-wrap">
              {pl.status === 'Draft' && <>
                <button onClick={handleAddBox} className="secondary-button min-h-11"><PlusIcon /> Add Box</button>
                <button disabled={!boxes.length} onClick={() => setScanModal(true)} className="primary-button min-h-11"><ScanIcon /> Scan QR</button>
                <button onClick={() => setAddShipModal(true)} className="secondary-button min-h-11">Add Shipments</button>
              </>}
              {(pl.status === 'Draft' || pl.status === 'Closed') && <button disabled={!contexts.length} onClick={() => setDispatchConfirm(true)} className="secondary-button min-h-11">Dispatch All</button>}
              <button onClick={() => void printPackingList(pl, listShipments, boxes, packingAllocations, customers, settings)} className="secondary-button min-h-11"><PrintIcon /> Print</button>
              {pl.status === 'Draft' && <button disabled={!canClosePl} title={closeBlockers[0]} onClick={() => setCloseConfirm(true)} className="min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40">Close Packing List</button>}
              {pl.status === 'Draft' && <button onClick={() => setDeleteTarget(pl.id)} className="secondary-button min-h-11 text-red-600">Delete</button>}
            </div>
          </header>
          <div className="grid grid-cols-2 divide-x divide-y divide-slate-100 md:grid-cols-4 md:divide-y-0">{[['Boxes', boxes.length], ['Customers', new Set(contexts.map(context => context.customer?.id || context.shipment.customerId)).size], ['Item Types', new Set(contexts.map(context => context.item.id)).size], ['Allocated', listTotals || '0']].map(([label, value]) => <div key={label as string} className="p-3 text-center"><div className="font-bold text-slate-800">{value}</div><div className="text-[10px] uppercase text-slate-400">{label}</div></div>)}</div>
        </section>

        <section className="section-surface p-4 md:p-5">
          <div className="flex gap-2 overflow-x-auto pb-3">{boxes.map(box => <button key={box.id} onClick={() => setSelectedBoxId(box.id)} className={`whitespace-nowrap rounded-xl border px-4 py-2 text-sm font-bold ${activeBoxId === box.id ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-slate-200 text-slate-600'}`}>{boxLabel(box.boxNumber)}<span className="ml-2 text-[10px] font-medium opacity-70">{contexts.filter(context => context.box.id === box.id).length} items</span></button>)}</div>
          {activeBox ? <><div className="mb-3 flex items-center justify-between"><div><h2 className="font-bold text-slate-800">{boxLabel(activeBox.boxNumber)}</h2><p className="text-xs text-slate-500">May contain items from multiple customers.</p></div><div className="text-right"><div className="text-xs text-slate-400">Box Total</div><div className="font-bold text-slate-800">{boxTotals || '0'}</div></div></div><BoxAllocations contexts={boxContexts} allBoxes={boxes} editable={pl.status === 'Draft'} editingId={editingId} editQuantity={editQuantity} onEdit={(id, quantity) => { setEditingId(id); setEditQuantity(String(quantity)) }} onEditQuantity={setEditQuantity} onSave={saveAllocation} onCancelEdit={() => setEditingId(null)} onRemove={removeAllocation} onMove={allocation => { setMovingId(allocation.id); setMoveQuantity(String(allocation.quantity)); setMoveBoxId(boxes.find(box => box.id !== allocation.boxId)?.id || '') }} onView={code => onNavigate('item-detail', code)} /></> : <p className="py-8 text-center text-sm text-slate-400">Create a box to begin packing.</p>}
        </section>

        <section className="section-surface overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-slate-50 px-4 py-3">
            <div><h2 className="text-sm font-semibold text-slate-700">Available Items</h2><p className="text-xs text-slate-400">Every cargo item across all shipments with quantity still to be packed.</p></div>
            <input value={availableQuery} onChange={event => setAvailableQuery(event.target.value)} placeholder="Search customer, tracking #, item code" className="form-input w-full sm:w-64" />
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead><tr className="border-b border-slate-100 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400"><th className="px-4 py-2">Customer</th><th className="px-4 py-2">Shipment</th><th className="px-4 py-2">Item</th><th className="px-4 py-2 text-right">Total</th><th className="px-4 py-2 text-right">Packed</th><th className="px-4 py-2 text-right">Remaining</th><th className="px-4 py-2"></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {availableItems.map(entry => (
                  <tr key={entry.item.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 text-slate-700">{entry.customer?.company || entry.customer?.name || entry.shipment.customerNameSnapshot || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">{entry.shipment.trackingNumber}</td>
                    <td className="px-4 py-2"><div className="font-medium text-slate-800">{entry.item.description}</div><div className="font-mono text-[10px] text-orange-700">{entry.item.itemCode}</div></td>
                    <td className="px-4 py-2 text-right text-slate-600">{formatPackingQuantity(entry.item.quantity)} {entry.item.unit}</td>
                    <td className="px-4 py-2 text-right text-slate-600">{formatPackingQuantity(entry.packed)}</td>
                    <td className="px-4 py-2 text-right font-semibold text-emerald-700">{formatPackingQuantity(entry.remaining)}</td>
                    <td className="px-4 py-2 text-right">{pl.status === 'Draft' && <button onClick={() => packFromAvailableItems(entry)} disabled={!activeBoxId} className="text-xs font-semibold text-blue-600 disabled:opacity-40">Pack</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!availableItems.length && <p className="py-8 text-center text-sm text-slate-400">{availableQuery ? 'No matching items with quantity remaining.' : 'Every cargo item is fully packed.'}</p>}
          </div>
        </section>

        {contexts.length > 0 && <CustomerSummary contexts={contexts} allocations={packingAllocations} packingLists={packingLists} />}

        <section className="section-surface"><div className="border-b bg-slate-50 px-4 py-3"><h2 className="text-sm font-semibold text-slate-700">Shipments in This Packing List</h2><p className="text-xs text-slate-400">Kept for the existing dispatch workflow; scanned items add their shipment automatically. Packing progress is read-only here — it reflects box allocations, not a separate stored value.</p></div><div className="divide-y divide-slate-100">{listShipments.map(shipment => { const customer = customers.find(candidate => candidate.id === shipment.customerId); const summary = shipmentPackingSummary(shipment.items, packingAllocations, packingLists); return <div key={shipment.id} className="flex items-center gap-3 px-4 py-3"><button onClick={() => onNavigate('shipment-detail', shipment.id)} className="font-mono text-xs font-bold text-[#0c1c35] hover:underline">{shipment.trackingNumber}</button><div className="min-w-0 flex-1 text-sm text-slate-600 truncate">{customer?.company || customer?.name} · {shipment.description}</div><PackingProgressBadge state={summary.state} />{pl.status === 'Draft' && !contexts.some(context => context.shipment.id === shipment.id) && <button onClick={() => removeShipmentFromPackingList(pl.id, shipment.id).catch(error => toast.error(error instanceof Error ? error.message : 'Shipment could not be removed.'))} className="text-xs text-red-500">Remove</button>}</div>})}{!listShipments.length && <p className="p-6 text-center text-sm text-slate-400">No shipments or scanned items yet.</p>}</div></section>
      </div>}

      <Modal open={createModal} onClose={() => setCreateModal(false)} title="New Packing List"><div className="space-y-3"><label className="block"><span className="form-label">Packing List Name</span><input value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => event.key === 'Enter' && handleCreate()} placeholder="e.g. Sea Cargo Batch - August 2026" className="form-input" /></label><div className="flex gap-2"><button onClick={() => setCreateModal(false)} className="secondary-button flex-1">Cancel</button><button onClick={handleCreate} className="primary-button flex-1">Create</button></div></div></Modal>

      <Modal open={scanModal} onClose={() => { setScanModal(false); setSelectedItem(null); setScanQuery(''); setPackQuantity('') }} title={`Scan Item - ${boxLabel(activeBox?.boxNumber)}`} width="max-w-2xl"><div className="space-y-4"><ItemQrScanner key={scanSession} compact onCode={selectScannedValue} />{scanQuery && !selectedItem && <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200 divide-y">{searchResults.map(context => <button key={context.item.id} onClick={() => { setSelectedItem(context); setScanQuery('') }} className="w-full p-3 text-left hover:bg-slate-50"><div className="font-mono text-xs font-bold text-orange-700">{context.item.itemCode}</div><div className="text-sm font-semibold text-slate-800">{context.item.description}</div><div className="text-xs text-slate-500">{context.customer?.company || context.customer?.name} · {context.shipment.trackingNumber}</div></button>)}{!searchResults.length && <p className="p-4 text-sm text-slate-400">No items found.</p>}</div>}{selectedItem && <div className="rounded-xl border border-orange-200 bg-orange-50 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="font-mono text-xs font-bold text-orange-700">{selectedItem.item.itemCode}</div><div className="font-bold text-slate-800">{selectedItem.item.description}</div><div className="text-xs text-slate-600">{selectedItem.customer?.company || selectedItem.customer?.name} · {selectedItem.shipment.trackingNumber}</div></div><div className="text-right text-xs"><div>Original: <strong>{formatPackingQuantity(selectedItem.item.quantity)} {selectedItem.item.unit}</strong></div><div>Allocated: <strong>{formatPackingQuantity(allocatedQuantity(selectedItem.item.id, packingAllocations, packingLists))}</strong></div><div className="text-emerald-700">Available: <strong>{formatPackingQuantity(availableQuantity(selectedItem.item, packingAllocations, packingLists))}</strong></div></div></div>{selectedExisting && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-100 px-3 py-2 text-xs text-amber-900">This item is already in {boxLabel(activeBox?.boxNumber)}. Current quantity: {formatPackingQuantity(selectedExisting.quantity)} {selectedItem.item.unit}. Add More Quantity or cancel.</div>}<label className="mt-3 block"><span className="form-label">Quantity in This Box</span><input type="number" min="0.001" step="0.001" max={availableQuantity(selectedItem.item, packingAllocations, packingLists)} value={packQuantity} onChange={event => setPackQuantity(event.target.value)} className="form-input" /></label><div className="mt-3 flex gap-2"><button onClick={() => { setSelectedItem(null); setPackQuantity('') }} className="secondary-button flex-1">Cancel</button><button onClick={addSelectedItem} className="primary-button flex-1">{selectedExisting ? 'Add More Quantity' : 'Add to Box'}</button></div></div>}</div></Modal>

      <Modal open={addShipModal} onClose={() => { setAddShipModal(false); setAddShipSearch('') }} title="Add Shipments to Packing List"><div className="space-y-3"><input value={addShipSearch} onChange={event => setAddShipSearch(event.target.value)} placeholder="Search tracking # or customer" className="form-input" /><div className="max-h-64 overflow-y-auto space-y-2">{availableToAdd.map(shipment => { const customer = customers.find(candidate => candidate.id === shipment.customerId); return <button key={shipment.id} onClick={async () => { try { await addShipmentToPackingList(pl!.id, shipment.id); toast.success(`${shipment.trackingNumber} added.`) } catch (error) { toast.error(error instanceof Error ? error.message : 'Shipment could not be added.') } }} className="w-full rounded-lg border border-slate-100 p-3 text-left hover:bg-slate-50"><div className="font-mono text-xs font-semibold text-[#0c1c35]">{shipment.trackingNumber}</div><div className="text-xs text-slate-500">{customer?.company || customer?.name} · {shipment.destinationCity}</div></button>})}{!availableToAdd.length && <p className="py-6 text-center text-sm text-slate-400">No eligible shipments found.</p>}</div><button onClick={() => setAddShipModal(false)} className="secondary-button w-full">Done</button></div></Modal>

      <Modal open={!!movingId} onClose={() => setMovingId(null)} title="Move Item Quantity"><div className="space-y-3"><label className="block"><span className="form-label">Move Quantity</span><input type="number" min="0.001" step="0.001" value={moveQuantity} onChange={event => setMoveQuantity(event.target.value)} className="form-input" /></label><label className="block"><span className="form-label">To Box</span><select value={moveBoxId} onChange={event => setMoveBoxId(event.target.value)} className="form-input">{boxes.filter(box => box.id !== packingAllocations.find(allocation => allocation.id === movingId)?.boxId).map(box => <option key={box.id} value={box.id}>{boxLabel(box.boxNumber)}</option>)}</select></label><div className="flex gap-2"><button onClick={() => setMovingId(null)} className="secondary-button flex-1">Cancel</button><button onClick={moveAllocation} className="primary-button flex-1">Move Quantity</button></div></div></Modal>

      <Modal open={dispatchConfirm} onClose={() => setDispatchConfirm(false)} title="Dispatch Packing List" width="max-w-2xl">
        <div className="space-y-4">
          {dispatchRemainingItems.length > 0 ? <>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Some shipment items on this Packing List's shipments are still not fully packed. Dispatching will not mark them as packed for you — pack the rest into a later Packing List when ready, or dispatch as-is.
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead><tr className="border-b border-slate-100 bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400"><th className="px-3 py-2">Item</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Packed</th><th className="px-3 py-2 text-right">Remaining</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {dispatchRemainingItems.map(entry => <tr key={entry.item.id}>
                    <td className="px-3 py-2"><div className="font-medium text-slate-800">{entry.item.description}</div><div className="font-mono text-[10px] text-slate-400">{entry.item.itemCode} · {entry.shipment.trackingNumber}</div></td>
                    <td className="px-3 py-2 text-right text-slate-600">{formatPackingQuantity(entry.item.quantity)} {entry.item.unit}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{formatPackingQuantity(entry.packed)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-amber-700">{formatPackingQuantity(entry.remaining)}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setDispatchConfirm(false)} className="secondary-button flex-1">Continue Packing</button>
              <button onClick={handleDispatch} className="primary-button flex-1">Dispatch Anyway</button>
            </div>
          </> : <>
            <p className="text-sm text-slate-600">Dispatch {pl?.listId} with {contexts.length} allocated item line(s)? The Packing List and boxes will be locked.</p>
            <div className="flex gap-2">
              <button onClick={() => setDispatchConfirm(false)} className="secondary-button flex-1">Cancel</button>
              <button onClick={handleDispatch} className="primary-button flex-1">Dispatch</button>
            </div>
          </>}
        </div>
      </Modal>
      <ConfirmDialog open={closeConfirm} title="Close this packing list?" message="Once closed, its items and quantities cannot be changed. Please verify the contents before continuing." confirmLabel="Close Packing List" danger={false} onConfirm={handleClose} onCancel={() => setCloseConfirm(false)} />
      <ConfirmDialog open={!!deleteTarget} title="Delete Draft Packing List" message="Delete this draft? Its box allocations will be released, but Shipment Item quantities will not change." onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
    </div>
  )
}

function BoxAllocations({ contexts, allBoxes, editable, editingId, editQuantity, onEdit, onEditQuantity, onSave, onCancelEdit, onRemove, onMove, onView }: { contexts: ReturnType<typeof allocationContexts>; allBoxes: ReturnType<typeof useAppStore.getState>['packingBoxes']; editable: boolean; editingId: string | null; editQuantity: string; onEdit: (id: string, quantity: number) => void; onEditQuantity: (value: string) => void; onSave: (id: string) => void; onCancelEdit: () => void; onRemove: (id: string) => void; onMove: (allocation: ReturnType<typeof allocationContexts>[number]['allocation']) => void; onView: (code: string) => void }) {
  const groups = new Map<string, typeof contexts>()
  contexts.forEach(context => { const key = context.customer?.id || context.shipment.customerId; groups.set(key, [...(groups.get(key) || []), context]) })
  if (!contexts.length) return <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center"><p className="text-sm text-slate-400">This box is empty.</p><p className="text-xs text-slate-400 mt-1">Tap Scan Item to begin.</p></div>
  return <div className="space-y-4">{[...groups.values()].map(group => { const customerName = group[0].customer?.company || group[0].customer?.name || group[0].shipment.customerNameSnapshot || 'Customer'; return <div key={group[0].customer?.id || group[0].shipment.customerId} className="overflow-hidden rounded-xl border border-slate-200"><div className="bg-[#0c1c35] px-4 py-2 text-sm font-bold text-white">{customerName.toUpperCase()}</div><div className="divide-y divide-slate-100">{group.map(context => <div key={context.allocation.id} className="p-3"><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><button onClick={() => context.item.itemCode && onView(context.item.itemCode)} className="font-semibold text-slate-800 hover:underline">{context.item.description}</button><div className="font-mono text-[10px] text-orange-700">{context.item.itemCode} · {context.shipment.trackingNumber}</div></div>{editingId === context.allocation.id ? <div className="flex items-center gap-2"><input type="number" min="0.001" step="0.001" value={editQuantity} onChange={event => onEditQuantity(event.target.value)} className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" /><span className="text-xs">{context.item.unit}</span><button onClick={() => onSave(context.allocation.id)} className="text-xs font-semibold text-emerald-700">Save</button><button onClick={onCancelEdit} className="text-xs text-slate-500">Cancel</button></div> : <div className="text-right"><div className="font-bold text-slate-800">{formatPackingQuantity(context.allocation.quantity)} {context.item.unit}</div>{editable && <div className="mt-1 flex gap-2 text-xs"><button onClick={() => onEdit(context.allocation.id, context.allocation.quantity)} className="text-blue-600">Edit</button>{allBoxes.length > 1 && <button onClick={() => onMove(context.allocation)} className="text-violet-600">Move</button>}<button onClick={() => onRemove(context.allocation.id)} className="text-red-500">Remove</button></div>}</div>}</div></div>)}</div><div className="bg-slate-50 px-4 py-2 text-right text-xs font-semibold text-slate-600">Customer Box Total: {unitTotals(group.map(context => ({ quantity: context.allocation.quantity, unit: context.item.unit })))}</div></div> })}</div>
}

function CustomerSummary({ contexts, allocations, packingLists }: { contexts: ReturnType<typeof allocationContexts>; allocations: ReturnType<typeof useAppStore.getState>['packingAllocations']; packingLists: ReturnType<typeof useAppStore.getState>['packingLists'] }) {
  const groups = new Map<string, typeof contexts>()
  contexts.forEach(context => { const key = context.customer?.id || context.shipment.customerId; groups.set(key, [...(groups.get(key) || []), context]) })
  return <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden"><div className="border-b bg-slate-50 px-4 py-3"><h2 className="text-sm font-semibold text-slate-700">Customer Summary</h2><p className="text-xs text-slate-400">Remaining means original Shipment Item quantity minus active Packing List allocations.</p></div><div className="grid gap-4 p-4 lg:grid-cols-2">{[...groups.values()].map(group => { const uniqueItems = [...new Map(group.map(context => [context.item.id, context])).values()]; const customerName = group[0].customer?.company || group[0].customer?.name || group[0].shipment.customerNameSnapshot || 'Customer'; return <div key={group[0].customer?.id || group[0].shipment.customerId} className="rounded-xl border border-slate-200 overflow-hidden"><div className="bg-slate-100 px-3 py-2 text-sm font-bold text-slate-800">{customerName.toUpperCase()}</div><div className="divide-y divide-slate-100">{uniqueItems.map(context => { const inThisList = group.filter(entry => entry.item.id === context.item.id).reduce((sum, entry) => sum + entry.allocation.quantity, 0); const totalAllocated = allocatedQuantity(context.item.id, allocations, packingLists); return <div key={context.item.id} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-xs"><div><div className="font-semibold text-slate-700">{context.item.description}</div><div className="font-mono text-[10px] text-slate-400">{context.item.itemCode}</div></div><div className="text-right"><div>Original {formatPackingQuantity(context.item.quantity)} {context.item.unit}</div><div>In this list {formatPackingQuantity(inThisList)}</div><div className="font-semibold text-emerald-700">Remaining {formatPackingQuantity(Math.max(0, context.item.quantity - totalAllocated))}</div></div></div>})}</div></div>})}</div></section>
}

function PackingProgressBadge({ state }: { state: PackingState }) {
  const classes = state === 'FULLY_PACKED' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : state === 'PARTIALLY_PACKED' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-100 text-slate-500 border-slate-200'
  const label = state === 'FULLY_PACKED' ? 'Fully Packed' : state === 'PARTIALLY_PACKED' ? 'Partially Packed' : 'Not Packed'
  return <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold ${classes}`}>{label}</span>
}

function boxLabel(number?: number) { return number ? `BOX ${String(number).padStart(3, '0')}` : 'Box' }
function unitTotals(entries: { quantity: number; unit: string }[]): string { const totals = new Map<string, number>(); entries.forEach(entry => totals.set(entry.unit, (totals.get(entry.unit) || 0) + entry.quantity)); return [...totals.entries()].map(([unit, quantity]) => `${formatPackingQuantity(quantity)} ${unit}`).join(' · ') }
const PlusIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
const ScanIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7V5a1 1 0 011-1h2m10 0h2a1 1 0 011 1v2M4 17v2a1 1 0 001 1h2m10 0h2a1 1 0 001-1v-2M8 8h3v3H8V8zm5 0h3v3h-3V8zm-5 5h3v3H8v-3zm5 0h1m2 0h1v3h-3v-1" /></svg>
const PrintIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10zM7 9V4h10v5" /></svg>
