import assert from 'node:assert/strict'
import test from 'node:test'
import type { PackingAllocation, PackingList, Shipment, ShipmentItem } from '../types'
import {
  allocatedQuantity,
  availableQuantity,
  closePackingListBlockers,
  itemCodeFromQrValue,
  packingState,
  shipmentPackingSummary,
  validateAllocationQuantity,
} from './packing.ts'

const item: ShipmentItem = {
  id: 'item-abaya', itemNumber: 4, itemCode: 'TC00125-04', description: 'Abayas',
  quantity: 200, unit: 'PCS', sortOrder: 4,
}
const lists: PackingList[] = [
  { id: 'pl-1', listId: 'PL-001', status: 'Draft', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' },
  { id: 'pl-2', listId: 'PL-002', status: 'Dispatched', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' },
]

function makeShipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: 'sh-1', trackingNumber: 'TC00125', status: 'RECEIVED', shipmentType: 'Air Cargo',
    cargoCategory: 'General Cargo', serviceType: 'Door-to-Door Delivery', customerId: 'cust-1',
    origin: 'Dubai, UAE', destination: 'Tanzania', destinationCity: 'Dar es Salaam',
    description: 'Abayas and scarves', items: [item], weightKg: 20, volumeCbm: 0.5, pcs: 200,
    shippingRate: 'Standard', baseRate: 0, otherCharges: 0, discount: 0, totalAmount: 0, amountPaid: 0,
    currency: 'USD', rateOverridden: false, baseCurrency: 'USD', statusHistory: [],
    createdAt: '', updatedAt: '', createdBy: 'System',
    ...overrides,
  }
}
const allocations: PackingAllocation[] = [
  { id: 'a1', packingListId: 'pl-1', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 10, createdAt: '', updatedAt: '' },
  { id: 'a2', packingListId: 'pl-1', boxId: 'box-2', shipmentItemId: 'item-abaya', quantity: 40, createdAt: '', updatedAt: '' },
]

test('Ali Hussain reconciliation keeps the original 200 PCS unchanged', () => {
  assert.equal(allocatedQuantity(item.id, allocations, lists), 50)
  assert.equal(availableQuantity(item, allocations, lists), 150)
  assert.equal(item.quantity, 200)
})

test('item QR parser accepts safe item query routes and raw codes', () => {
  assert.equal(itemCodeFromQrValue('https://cargo.example/?item=TC00125-04'), 'TC00125-04')
  assert.equal(itemCodeFromQrValue('/items/TC00125-04'), 'TC00125-04')
  assert.equal(itemCodeFromQrValue('TC00125-04'), 'TC00125-04')
})

test('nothing packed: zero allocations means fully available and NOT_PACKED', () => {
  assert.equal(allocatedQuantity(item.id, [], lists), 0)
  assert.equal(availableQuantity(item, [], lists), 200)
  assert.equal(packingState(item, [], lists), 'NOT_PACKED')
})

test('partially packed: some but not all quantity allocated', () => {
  assert.equal(packingState(item, allocations, lists), 'PARTIALLY_PACKED')
})

test('fully packed: allocations sum to exactly the item quantity', () => {
  const fullAllocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-1', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 200, createdAt: '', updatedAt: '' },
  ]
  assert.equal(allocatedQuantity(item.id, fullAllocations, lists), 200)
  assert.equal(availableQuantity(item, fullAllocations, lists), 0)
  assert.equal(packingState(item, fullAllocations, lists), 'FULLY_PACKED')
})

test('multiple boxes: same item split across several boxes in the same list sums correctly', () => {
  const splitAllocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-1', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 60, createdAt: '', updatedAt: '' },
    { id: 'a2', packingListId: 'pl-1', boxId: 'box-2', shipmentItemId: 'item-abaya', quantity: 60, createdAt: '', updatedAt: '' },
    { id: 'a3', packingListId: 'pl-1', boxId: 'box-3', shipmentItemId: 'item-abaya', quantity: 60, createdAt: '', updatedAt: '' },
  ]
  assert.equal(allocatedQuantity(item.id, splitAllocations, lists), 180)
  assert.equal(availableQuantity(item, splitAllocations, lists), 20)
})

test('same item split across boxes in different packing lists (Draft + Dispatched) both count', () => {
  const crossListAllocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-1', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 30, createdAt: '', updatedAt: '' },
    { id: 'a2', packingListId: 'pl-2', boxId: 'box-9', shipmentItemId: 'item-abaya', quantity: 25, createdAt: '', updatedAt: '' },
  ]
  assert.equal(allocatedQuantity(item.id, crossListAllocations, lists), 55)
})

test('allocations belonging to a packing list outside the known Draft/Dispatched set are excluded from the total', () => {
  const withOrphan: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-1', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 30, createdAt: '', updatedAt: '' },
    { id: 'a2', packingListId: 'pl-removed', boxId: 'box-9', shipmentItemId: 'item-abaya', quantity: 999, createdAt: '', updatedAt: '' },
  ]
  assert.equal(allocatedQuantity(item.id, withOrphan, lists), 30)
})

test('remaining quantity never goes negative even if allocations somehow exceed the item quantity', () => {
  const overAllocated: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-1', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 250, createdAt: '', updatedAt: '' },
  ]
  assert.equal(availableQuantity(item, overAllocated, lists), 0)
})

test('validateAllocationQuantity rejects over-allocation', () => {
  assert.equal(validateAllocationQuantity(151, 150), 'Only 150 available for this item.')
  assert.equal(validateAllocationQuantity(150, 150), null)
})

test('validateAllocationQuantity rejects zero and negative quantities', () => {
  assert.equal(validateAllocationQuantity(0, 150), 'Quantity must be greater than zero.')
  assert.equal(validateAllocationQuantity(-5, 150), 'Quantity must be greater than zero.')
  assert.equal(validateAllocationQuantity(Number.NaN, 150), 'Quantity must be greater than zero.')
})

test('validateAllocationQuantity accepts an in-range quantity', () => {
  assert.equal(validateAllocationQuantity(50, 150), null)
})

test('shipmentPackingSummary groups by unit and derives an overall state', () => {
  const secondItem: ShipmentItem = {
    id: 'item-scarf', itemNumber: 5, itemCode: 'TC00125-05', description: 'Scarves',
    quantity: 10, unit: 'CARTON', sortOrder: 5,
  }
  const mixed: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-1', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 200, createdAt: '', updatedAt: '' },
    { id: 'a2', packingListId: 'pl-1', boxId: 'box-1', shipmentItemId: 'item-scarf', quantity: 4, createdAt: '', updatedAt: '' },
  ]
  const summary = shipmentPackingSummary([item, secondItem], mixed, lists)
  const pcsTotal = summary.totals.find(t => t.unit === 'PCS')
  const cartonTotal = summary.totals.find(t => t.unit === 'CARTON')
  assert.deepEqual(pcsTotal, { unit: 'PCS', total: 200, packed: 200, remaining: 0 })
  assert.deepEqual(cartonTotal, { unit: 'CARTON', total: 10, packed: 4, remaining: 6 })
  assert.equal(summary.state, 'PARTIALLY_PACKED')
})

test('shipmentPackingSummary reports NOT_PACKED for an empty item list and FULLY_PACKED when everything is packed', () => {
  assert.equal(shipmentPackingSummary([], [], lists).state, 'NOT_PACKED')
  const fullAllocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-1', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 200, createdAt: '', updatedAt: '' },
  ]
  assert.equal(shipmentPackingSummary([item], fullAllocations, lists).state, 'FULLY_PACKED')
})

// --- Close Packing List ------------------------------------------------

const listsWithClosed: PackingList[] = [
  ...lists,
  { id: 'pl-3', listId: 'PL-003', status: 'Closed', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '', closedAt: '2026-08-17 21:43', closedBy: 'Admin' },
]

test('a Closed packing list still counts its allocations toward an item\'s packed quantity', () => {
  const closedAllocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-3', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 60, createdAt: '', updatedAt: '' },
  ]
  assert.equal(allocatedQuantity(item.id, closedAllocations, listsWithClosed), 60)
  assert.equal(availableQuantity(item, closedAllocations, listsWithClosed), 140)
})

test('closePackingListBlockers: an open Draft list with valid allocations can be closed', () => {
  const draft: PackingList = { id: 'pl-open', listId: 'PL-010', status: 'Draft', shipmentIds: ['sh-1'], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }
  const draftAllocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-open', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 50, createdAt: '', updatedAt: '' },
  ]
  assert.deepEqual(closePackingListBlockers(draft, draftAllocations, [makeShipment()], [draft]), [])
})

test('closePackingListBlockers: an already-closed or dispatched list cannot be closed again', () => {
  const closed: PackingList = { id: 'pl-3', listId: 'PL-003', status: 'Closed', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }
  const dispatched: PackingList = { id: 'pl-2', listId: 'PL-002', status: 'Dispatched', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }
  assert.deepEqual(closePackingListBlockers(closed, [], [], []), ['Only an open Packing List can be closed.'])
  assert.deepEqual(closePackingListBlockers(dispatched, [], [], []), ['Only an open Packing List can be closed.'])
})

test('closePackingListBlockers: a list with no allocations cannot be closed', () => {
  const empty: PackingList = { id: 'pl-empty', listId: 'PL-011', status: 'Draft', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }
  assert.deepEqual(closePackingListBlockers(empty, [], [], [empty]), ['Add at least one packed item before closing.'])
})

test('closePackingListBlockers: an invalid (zero/negative) allocation quantity blocks closing', () => {
  const draft: PackingList = { id: 'pl-bad', listId: 'PL-012', status: 'Draft', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }
  const badAllocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-bad', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 0, createdAt: '', updatedAt: '' },
  ]
  assert.deepEqual(closePackingListBlockers(draft, badAllocations, [makeShipment()], [draft]), ['This Packing List has an item with an invalid quantity.'])
})

test('closePackingListBlockers: an over-allocated item (combined with another active list) blocks closing', () => {
  const draft: PackingList = { id: 'pl-over-a', listId: 'PL-013', status: 'Draft', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }
  const otherDraft: PackingList = { id: 'pl-over-b', listId: 'PL-014', status: 'Draft', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }
  const overAllocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-over-a', boxId: 'box-1', shipmentItemId: 'item-abaya', quantity: 150, createdAt: '', updatedAt: '' },
    { id: 'a2', packingListId: 'pl-over-b', boxId: 'box-2', shipmentItemId: 'item-abaya', quantity: 100, createdAt: '', updatedAt: '' },
  ]
  assert.deepEqual(
    closePackingListBlockers(draft, overAllocations, [makeShipment()], [draft, otherDraft]),
    ['One or more items exceed the original Shipment Item quantity.'],
  )
})
