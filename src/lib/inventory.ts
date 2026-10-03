import type { InventoryPackingStatus, PackingAllocation, PackingList, ShipmentItem } from '../types'
import { allocatedQuantity } from './packing.ts'

export interface InventoryQuantities {
  totalQuantity: number
  packedQuantity: number
  dispatchedQuantity: number
  returnedQuantity: number
  storageQuantity: number
  remainingQuantity: number
}

export interface ItemReturnRecord {
  shipmentItemId: string
  quantity: number
}

/**
 * Client-side mirror of search_inventory()/get_inventory_item_detail() in
 * supabase/migrations/20260817184710_storage_inventory.sql — the database
 * is the source of truth for the Storage screen itself (this function exists
 * so the formula is unit-testable and so any future offline/preview use has
 * one place to compute it, not two independently-maintained definitions).
 *
 * - packedQuantity reuses allocatedQuantity() unchanged: Draft + Closed +
 *   Dispatched allocations. This is the exact "packed" meaning already used
 *   everywhere else in the app (ItemDetails, ShipmentDetail, PackingList) —
 *   deliberately not redefined here.
 * - dispatchedQuantity only counts allocations sitting in a Dispatched list —
 *   the point at which an item has actually left the Dubai warehouse.
 * - storageQuantity = total - dispatched - returned, floored at 0: an item
 *   packed into a Draft/Closed box is still physically in storage.
 * - remainingQuantity = total - packed (existing "available to pack" meaning).
 */
export function computeInventoryQuantities(
  item: ShipmentItem,
  allocations: PackingAllocation[],
  packingLists: PackingList[],
  returns: ItemReturnRecord[],
): InventoryQuantities {
  const packedQuantity = allocatedQuantity(item.id, allocations, packingLists)

  const dispatchedListIds = new Set(packingLists.filter(list => list.status === 'Dispatched').map(list => list.id))
  const dispatchedQuantity = item.id
    ? allocations
        .filter(allocation => allocation.shipmentItemId === item.id && dispatchedListIds.has(allocation.packingListId))
        .reduce((sum, allocation) => sum + allocation.quantity, 0)
    : 0

  const returnedQuantity = item.id
    ? returns.filter(entry => entry.shipmentItemId === item.id).reduce((sum, entry) => sum + entry.quantity, 0)
    : 0

  const storageQuantity = Math.max(0, item.quantity - dispatchedQuantity - returnedQuantity)
  const remainingQuantity = Math.max(0, item.quantity - packedQuantity)

  return {
    totalQuantity: item.quantity,
    packedQuantity,
    dispatchedQuantity,
    returnedQuantity,
    storageQuantity,
    remainingQuantity,
  }
}

export function inventoryPackingStatus(totalQuantity: number, packedQuantity: number): InventoryPackingStatus {
  if (packedQuantity <= 0) return 'NOT_PACKED'
  if (packedQuantity >= totalQuantity) return 'FULLY_PACKED'
  return 'PARTIALLY_PACKED'
}

export function inventoryPackingStatusLabel(status: InventoryPackingStatus): string {
  switch (status) {
    case 'NOT_PACKED': return 'Not Packed'
    case 'PARTIALLY_PACKED': return 'Partially Packed'
    case 'FULLY_PACKED': return 'Fully Packed'
  }
}
