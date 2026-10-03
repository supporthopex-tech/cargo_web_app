import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateBaseAmount, calculateCbm, convertUsd, invoiceAmountFor } from './pricing.ts'
import { findApplicableExchangeRate } from './exchangeRateService.ts'
import type { ExchangeRate } from '../types/index.ts'

const rates: ExchangeRate[] = [
  {
    id: 'rate-a', rateDate: '2026-08-07', baseCurrency: 'USD', usdToTzs: 2600,
    usdToAed: 3.6725, source: 'MANUAL', createdAt: '', updatedAt: '',
  },
  {
    id: 'rate-b', rateDate: '2026-08-08', baseCurrency: 'USD', usdToTzs: 2610,
    usdToAed: 3.6725, source: 'MANUAL', createdAt: '', updatedAt: '',
  },
]

test('Air Cargo: 20 KG x USD 10/KG is USD 200.00', () => {
  assert.equal(calculateBaseAmount('20', '10'), '200.00')
  assert.equal(invoiceAmountFor('200.00', 'TZS', '2600'), '520000')
})

test('Sea Cargo: 3 CBM x USD 300/CBM is USD 900.00', () => {
  assert.equal(calculateBaseAmount('3', '300'), '900.00')
  assert.equal(invoiceAmountFor('900.00', 'AED', undefined, '3.6725'), '3305.25')
})

test('decimal pricing rounds once at the currency boundary', () => {
  assert.equal(calculateBaseAmount('20.75', '9.125'), '189.34')
  assert.equal(convertUsd('189.34', '2600.125', 'TZS'), '492308')
})

test('CBM calculator supports dimensions and package count', () => {
  assert.equal(calculateCbm('100', '100', '100', '3'), '3.0000')
})

test('exact-rate policy does not silently use an older rate', () => {
  assert.equal(findApplicableExchangeRate(rates, '2026-08-09', 'REQUIRE_TODAY'), null)
})

test('carry-forward policy identifies the saved historical rate date', () => {
  const result = findApplicableExchangeRate(rates, '2026-08-09', 'LATEST_APPROVED')
  assert.equal(result?.rate.rateDate, '2026-08-08')
  assert.equal(result?.isCarryForward, true)
})

test('an old shipment snapshot is independent from later configured rates', () => {
  const shipmentA = {
    appliedRateUsd: 10,
    baseAmountUsd: calculateBaseAmount('20', '10'),
    exchangeRateDate: rates[0].rateDate,
    invoiceAmount: invoiceAmountFor('200', 'TZS', String(rates[0].usdToTzs)),
  }
  assert.deepEqual(shipmentA, {
    appliedRateUsd: 10,
    baseAmountUsd: '200.00',
    exchangeRateDate: '2026-08-07',
    invoiceAmount: '520000',
  })
  assert.equal(calculateBaseAmount('20', '12'), '240.00')
  assert.equal(invoiceAmountFor('240', 'TZS', String(rates[1].usdToTzs)), '626400')
})
