import assert from 'node:assert/strict'
import test from 'node:test'
import { nextPackingListNumber, nextReceiptNumber, nextTrackingNumber } from './autoNumber.ts'

test('tracking numbers use the Hopex prefix and continue only the current sequence', () => {
  const first = nextTrackingNumber([])
  assert.match(first, /^HOPEX-\d{6}-0001$/)
  const prefix = first.slice(0, -4)
  assert.equal(nextTrackingNumber([
    `${prefix}0003`, `${prefix}0008`,
    first.replace('HOPEX-', 'TCAST-').replace('0001', '9999'),
    'HOPEX-000101-9999', `${prefix}invalid`,
  ]), `${prefix}0009`)
})

test('packing lists use Hopex without changing existing references', () => {
  const first = nextPackingListNumber([])
  assert.match(first, /^PL-HOPEX-\d{6}-001$/)
  const values = [first, first.replace('HOPEX', 'TCAST')]
  const original = [...values]
  assert.equal(nextPackingListNumber(values), first.replace(/001$/, '002'))
  assert.deepEqual(values, original)
})

test('receipt numbering retains the accounting receipt format', () => {
  const first = nextReceiptNumber([])
  assert.match(first, /^RCT-\d{6}-0001$/)
  assert.equal(nextReceiptNumber([first]), first.replace(/0001$/, '0002'))
})

test('company prefixes supplied by settings are honored with safe empty defaults', () => {
  assert.match(nextTrackingNumber([], 'CUSTOM'), /^CUSTOM-\d{6}-0001$/)
  assert.match(nextPackingListNumber([], 'PL-CUSTOM'), /^PL-CUSTOM-\d{6}-001$/)
  assert.match(nextTrackingNumber([], ''), /^HOPEX-\d{6}-0001$/)
  assert.match(nextPackingListNumber([], ''), /^PL-HOPEX-\d{6}-001$/)
})
