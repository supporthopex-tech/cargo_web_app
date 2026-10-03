import type {
  Customer,
  PackingAllocation,
  PackingBox,
  PackingList,
  Shipment,
  ShipmentItem,
} from '../types'

export interface ShipmentItemContext {
  item: ShipmentItem
  shipment: Shipment
  customer?: Customer
}

export interface PackingAllocationContext extends ShipmentItemContext {
  allocation: PackingAllocation
  box: PackingBox
}

export type PackingState = 'NOT_PACKED' | 'PARTIALLY_PACKED' | 'FULLY_PACKED'

/**
 * Derives a shipment item's packing state purely from its allocations —
 * there is no independent "packed" flag anywhere to fall out of sync.
 */
export function packingState(
  item: ShipmentItem,
  allocations: PackingAllocation[],
  packingLists?: PackingList[],
): PackingState {
  const packed = allocatedQuantity(item.id, allocations, packingLists)
  if (packed <= 0) return 'NOT_PACKED'
  if (packed >= item.quantity) return 'FULLY_PACKED'
  return 'PARTIALLY_PACKED'
}

/**
 * Client-side mirror of the checks `upsert_packing_allocation()` enforces in
 * Postgres (see supabase/migrations/20260809145324_item_qr_packing_allocations.sql).
 * This is defense in depth for fast, friendly UI feedback — the database
 * remains the authoritative source of truth and re-validates independently
 * on every write, so a bypass here can never produce an invalid allocation.
 */
export function validateAllocationQuantity(quantity: number, available: number): string | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return 'Quantity must be greater than zero.'
  if (quantity > available) return `Only ${formatPackingQuantity(available)} available for this item.`
  return null
}

export interface UnitTotal { unit: string; total: number; packed: number; remaining: number }

/**
 * Shipment-level packing summary, grouped by unit (a shipment can mix PCS,
 * CARTON, BOX items, so a single combined number would be meaningless).
 * Always derived from item-level allocations — never a stored aggregate.
 */
export function shipmentPackingSummary(
  items: ShipmentItem[],
  allocations: PackingAllocation[],
  packingLists?: PackingList[],
): { totals: UnitTotal[]; state: PackingState } {
  const byUnit = new Map<string, UnitTotal>()
  items.forEach(item => {
    const packed = allocatedQuantity(item.id, allocations, packingLists)
    const entry = byUnit.get(item.unit) || { unit: item.unit, total: 0, packed: 0, remaining: 0 }
    entry.total += item.quantity
    entry.packed += Math.min(packed, item.quantity)
    entry.remaining += Math.max(0, item.quantity - packed)
    byUnit.set(item.unit, entry)
  })
  const totals = [...byUnit.values()]
  const states = items.map(item => packingState(item, allocations, packingLists))
  const state: PackingState = states.length === 0 || states.every(s => s === 'NOT_PACKED')
    ? 'NOT_PACKED'
    : states.every(s => s === 'FULLY_PACKED') ? 'FULLY_PACKED' : 'PARTIALLY_PACKED'
  return { totals, state }
}

/**
 * Client-side mirror of close_packing_list()'s pre-close checks (see
 * supabase/migrations/20260817182455_close_packing_list.sql) — fast UI
 * feedback for disabling the "Close Packing List" button and explaining
 * why. The RPC re-validates every one of these independently; a bypass or
 * stale read here can never actually close an invalid Packing List.
 * Returns an empty array when the list is safe to close.
 */
export function closePackingListBlockers(
  pl: PackingList,
  allocations: PackingAllocation[],
  shipments: Shipment[],
  packingLists: PackingList[],
): string[] {
  if (pl.status !== 'Draft') return ['Only an open Packing List can be closed.']

  const blockers: string[] = []
  const listAllocations = allocations.filter(allocation => allocation.packingListId === pl.id)

  if (listAllocations.length === 0) {
    blockers.push('Add at least one packed item before closing.')
  }
  if (listAllocations.some(allocation => !Number.isFinite(allocation.quantity) || allocation.quantity <= 0)) {
    blockers.push('This Packing List has an item with an invalid quantity.')
  }

  const itemById = new Map<string, ShipmentItem>()
  shipments.forEach(shipment => shipment.items.forEach(item => { if (item.id) itemById.set(item.id, item) }))
  const overAllocated = listAllocations.some(allocation => {
    const item = itemById.get(allocation.shipmentItemId)
    return item ? allocatedQuantity(item.id, allocations, packingLists) > item.quantity : false
  })
  if (overAllocated) {
    blockers.push('One or more items exceed the original Shipment Item quantity.')
  }

  return blockers
}

export function allocatedQuantity(
  shipmentItemId: string | undefined,
  allocations: PackingAllocation[],
  packingLists?: PackingList[],
): number {
  if (!shipmentItemId) return 0
  const activeListIds = packingLists
    ? new Set(packingLists.filter(list => list.status === 'Draft' || list.status === 'Closed' || list.status === 'Dispatched').map(list => list.id))
    : null
  return allocations.reduce((total, allocation) => {
    if (allocation.shipmentItemId !== shipmentItemId) return total
    if (activeListIds && !activeListIds.has(allocation.packingListId)) return total
    return total + allocation.quantity
  }, 0)
}

export function availableQuantity(
  item: ShipmentItem,
  allocations: PackingAllocation[],
  packingLists?: PackingList[],
): number {
  return Math.max(0, item.quantity - allocatedQuantity(item.id, allocations, packingLists))
}

export function findItemContext(
  itemCode: string,
  shipments: Shipment[],
  customers: Customer[],
): ShipmentItemContext | undefined {
  const normalized = itemCode.trim().toLowerCase()
  for (const shipment of shipments) {
    const item = shipment.items.find(candidate => candidate.itemCode?.toLowerCase() === normalized)
    if (item) {
      return { item, shipment, customer: customers.find(customer => customer.id === shipment.customerId) }
    }
  }
  return undefined
}

export function searchItemContexts(
  query: string,
  shipments: Shipment[],
  customers: Customer[],
): ShipmentItemContext[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  return shipments.flatMap(shipment => {
    const customer = customers.find(candidate => candidate.id === shipment.customerId)
    const shipmentMatch = shipment.trackingNumber.toLowerCase().includes(normalized)
      || customer?.name.toLowerCase().includes(normalized)
      || customer?.company.toLowerCase().includes(normalized)
    return shipment.items
      .filter(item => shipmentMatch
        || item.itemCode?.toLowerCase().includes(normalized)
        || item.description.toLowerCase().includes(normalized))
      .map(item => ({ item, shipment, customer }))
  })
}

export function itemCodeFromQrValue(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed, 'https://hopex.invalid')
    const queryCode = url.searchParams.get('item')
    if (queryCode) return decodeURIComponent(queryCode).trim()
    const routeMatch = url.pathname.match(/\/items?\/([^/]+)$/i)
    if (routeMatch) return decodeURIComponent(routeMatch[1]).trim()
  } catch {
    // Manual scanners can return the raw item code.
  }
  return trimmed
}

export function formatPackingQuantity(quantity: number): string {
  return Number.isInteger(quantity) ? quantity.toLocaleString() : quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

export function allocationContexts(
  packingListId: string,
  boxes: PackingBox[],
  allocations: PackingAllocation[],
  shipments: Shipment[],
  customers: Customer[],
): PackingAllocationContext[] {
  const boxById = new Map(boxes.filter(box => box.packingListId === packingListId).map(box => [box.id, box]))
  const itemById = new Map<string, ShipmentItemContext>()
  shipments.forEach(shipment => {
    const customer = customers.find(candidate => candidate.id === shipment.customerId)
    shipment.items.forEach(item => {
      if (item.id) itemById.set(item.id, { item, shipment, customer })
    })
  })
  return allocations.flatMap(allocation => {
    if (allocation.packingListId !== packingListId) return []
    const box = boxById.get(allocation.boxId)
    const context = itemById.get(allocation.shipmentItemId)
    return box && context ? [{ allocation, box, ...context }] : []
  })
}
