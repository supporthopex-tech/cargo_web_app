import assert from 'node:assert/strict'
import test from 'node:test'
import { isCorrection, nextShipmentStatus, timelineState, validateStatusTransition } from './statusLifecycle.ts'

test('shipment lifecycle follows the seven required stages exactly', () => {
  assert.equal(nextShipmentStatus('RECEIVED'), 'PACKED')
  assert.equal(nextShipmentStatus('PACKED'), 'DISPATCHED')
  assert.equal(nextShipmentStatus('DISPATCHED'), 'ON_TRANSIT')
  assert.equal(nextShipmentStatus('ON_TRANSIT'), 'IN_CUSTOMS')
  assert.equal(nextShipmentStatus('IN_CUSTOMS'), 'ARRIVED')
  assert.equal(nextShipmentStatus('ARRIVED'), 'DELIVERED')
  assert.equal(nextShipmentStatus('DELIVERED'), null)
})

test('normal operations staff cannot skip a stage', () => {
  const errors = validateStatusTransition('RECEIVED', { status: 'DISPATCHED', location: 'Dubai' }, 'Staff')
  assert.ok(errors.some(error => error.includes('Admin or Manager')))
})

test('manager correction requires a reason', () => {
  assert.equal(isCorrection('RECEIVED', 'ON_TRANSIT'), true)
  assert.ok(validateStatusTransition('RECEIVED', { status: 'ON_TRANSIT', location: 'Dubai' }, 'Manager').some(error => error.includes('Reason')))
  assert.deepEqual(validateStatusTransition('RECEIVED', { status: 'ON_TRANSIT', location: 'Dubai', correctionReason: 'Legacy record correction' }, 'Manager'), [])
})

test('customs type and delivery confirmation are mandatory', () => {
  assert.ok(validateStatusTransition('ON_TRANSIT', { status: 'IN_CUSTOMS', location: 'DAR' }, 'Staff').some(error => error.includes('Customs type')))
  assert.ok(validateStatusTransition('ARRIVED', { status: 'DELIVERED', location: 'Moshi' }, 'Staff').length >= 2)
  assert.deepEqual(validateStatusTransition('ARRIVED', { status: 'DELIVERED', location: 'Moshi', delivery: { recipientName: 'Asha', deliveredAt: '2026-08-15T10:00:00.000Z' } }, 'Staff'), [])
})

test('timeline state marks earlier, current and future stages', () => {
  assert.equal(timelineState('IN_CUSTOMS', 'PACKED'), 'complete')
  assert.equal(timelineState('IN_CUSTOMS', 'IN_CUSTOMS'), 'current')
  assert.equal(timelineState('IN_CUSTOMS', 'DELIVERED'), 'future')
})
