import assert from 'node:assert/strict'
import test from 'node:test'
import type { PackingAllocation, PackingList, ShipmentItem } from '../types'
import { computeInventoryQuantities, inventoryPackingStatus } from './inventory.ts'

const item: ShipmentItem = {
  id: 'item-1', itemNumber: 1, itemCode: 'TC-001-01', description: 'Shoes',
  quantity: 100, unit: 'PCS', sortOrder: 1,
}

const draftList: PackingList = { id: 'pl-draft', listId: 'PL-001', status: 'Draft', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }
const closedList: PackingList = { id: 'pl-closed', listId: 'PL-002', status: 'Closed', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }
const dispatchedList: PackingList = { id: 'pl-dispatched', listId: 'PL-003', status: 'Dispatched', shipmentIds: [], origin: '', destination: '', shipmentType: 'Air Cargo', createdAt: '', updatedAt: '', createdBy: '' }

test('nothing packed, nothing dispatched, nothing returned: everything is in storage', () => {
  const q = computeInventoryQuantities(item, [], [], [])
  assert.deepEqual(q, {
    totalQuantity: 100, packedQuantity: 0, dispatchedQuantity: 0,
    returnedQuantity: 0, storageQuantity: 100, remainingQuantity: 100,
  })
  assert.equal(inventoryPackingStatus(q.totalQuantity, q.packedQuantity), 'NOT_PACKED')
})

test('packed into a Draft box: still fully in storage (packing does not remove from storage)', () => {
  const allocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-draft', boxId: 'box-1', shipmentItemId: 'item-1', quantity: 40, createdAt: '', updatedAt: '' },
  ]
  const q = computeInventoryQuantities(item, allocations, [draftList], [])
  assert.equal(q.packedQuantity, 40)
  assert.equal(q.dispatchedQuantity, 0)
  assert.equal(q.storageQuantity, 100, 'packed-but-not-dispatched items are still physically in storage')
  assert.equal(q.remainingQuantity, 60)
  assert.equal(inventoryPackingStatus(q.totalQuantity, q.packedQuantity), 'PARTIALLY_PACKED')
})

test('packed into a Closed box: still fully in storage, same as Draft', () => {
  const allocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-closed', boxId: 'box-1', shipmentItemId: 'item-1', quantity: 100, createdAt: '', updatedAt: '' },
  ]
  const q = computeInventoryQuantities(item, allocations, [closedList], [])
  assert.equal(q.packedQuantity, 100)
  assert.equal(q.dispatchedQuantity, 0)
  assert.equal(q.storageQuantity, 100)
  assert.equal(inventoryPackingStatus(q.totalQuantity, q.packedQuantity), 'FULLY_PACKED')
})

test('multiple boxes across multiple lists: packed and dispatched both sum correctly', () => {
  const allocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-draft', boxId: 'box-1', shipmentItemId: 'item-1', quantity: 20, createdAt: '', updatedAt: '' },
    { id: 'a2', packingListId: 'pl-dispatched', boxId: 'box-2', shipmentItemId: 'item-1', quantity: 50, createdAt: '', updatedAt: '' },
  ]
  const q = computeInventoryQuantities(item, allocations, [draftList, dispatchedList], [])
  assert.equal(q.packedQuantity, 70)
  assert.equal(q.dispatchedQuantity, 50, 'only the Dispatched-list allocation counts as dispatched')
  assert.equal(q.storageQuantity, 50, '100 total - 50 dispatched = 50 still physically in storage')
})

test('dispatched quantity leaves storage', () => {
  const allocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-dispatched', boxId: 'box-1', shipmentItemId: 'item-1', quantity: 100, createdAt: '', updatedAt: '' },
  ]
  const q = computeInventoryQuantities(item, allocations, [dispatchedList], [])
  assert.equal(q.dispatchedQuantity, 100)
  assert.equal(q.storageQuantity, 0)
})

test('returned cargo reduces storage but not packed/dispatched', () => {
  const q = computeInventoryQuantities(item, [], [], [{ shipmentItemId: 'item-1', quantity: 30 }])
  assert.equal(q.packedQuantity, 0)
  assert.equal(q.dispatchedQuantity, 0)
  assert.equal(q.returnedQuantity, 30)
  assert.equal(q.storageQuantity, 70)
})

test('dispatched and returned combine, storage never goes negative', () => {
  const allocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-dispatched', boxId: 'box-1', shipmentItemId: 'item-1', quantity: 60, createdAt: '', updatedAt: '' },
  ]
  const returns = [{ shipmentItemId: 'item-1', quantity: 50 }]
  const q = computeInventoryQuantities(item, allocations, [dispatchedList], returns)
  // 100 - 60 dispatched - 50 returned would be -10; must floor at 0.
  assert.equal(q.storageQuantity, 0)
})

test('returns and allocations for a different item are ignored', () => {
  const otherAllocations: PackingAllocation[] = [
    { id: 'a1', packingListId: 'pl-dispatched', boxId: 'box-1', shipmentItemId: 'item-other', quantity: 999, createdAt: '', updatedAt: '' },
  ]
  const otherReturns = [{ shipmentItemId: 'item-other', quantity: 999 }]
  const q = computeInventoryQuantities(item, otherAllocations, [dispatchedList], otherReturns)
  assert.equal(q.packedQuantity, 0)
  assert.equal(q.dispatchedQuantity, 0)
  assert.equal(q.returnedQuantity, 0)
  assert.equal(q.storageQuantity, 100)
})

test('inventoryPackingStatus boundary cases', () => {
  assert.equal(inventoryPackingStatus(100, 0), 'NOT_PACKED')
  assert.equal(inventoryPackingStatus(100, 1), 'PARTIALLY_PACKED')
  assert.equal(inventoryPackingStatus(100, 99), 'PARTIALLY_PACKED')
  assert.equal(inventoryPackingStatus(100, 100), 'FULLY_PACKED')
  assert.equal(inventoryPackingStatus(100, 150), 'FULLY_PACKED')
})
