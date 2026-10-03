import assert from 'node:assert/strict'
import test from 'node:test'
import type { AccountingAccount, ExchangeRate, JournalEntry, JournalLine } from '../types/index.ts'
import { balanceSheet, cashFlow, convertDatasetToCurrency, convertFromUsdBase, incomeStatement, journalIsBalanced, reportIntegrity, reportingAmount, shipmentFinancialSummary, trialBalance } from './accounting.ts'

const accounts: AccountingAccount[] = [
  ['cash', '1000', 'Cash', 'ASSET', 'DEBIT'], ['ar', '1100', 'Accounts Receivable', 'ASSET', 'DEBIT'],
  ['equity', '3000', 'Owner Capital', 'EQUITY', 'CREDIT'], ['revenue', '4000', 'Air Cargo Revenue', 'REVENUE', 'CREDIT'],
  ['expense', '5200', 'General Expenses', 'EXPENSE', 'DEBIT'],
].map(([id, code, name, accountType, normalBalance]) => ({ id, code, name, accountType: accountType as AccountingAccount['accountType'], normalBalance: normalBalance as AccountingAccount['normalBalance'], active: true, systemAccount: true, allowManualPosting: false }))

const entry = (id: string, type: string, amount: number, date = '2026-08-15'): JournalEntry => ({ id, entryNumber: `TJE-${id}`, entryDate: date, description: type, referenceType: type, referenceId: id, currency: 'USD', exchangeRate: 1, originalAmount: amount, baseAmount: amount, status: 'POSTED', createdAt: `${date}T00:00:00Z` })
const line = (id: string, journalEntryId: string, accountId: string, debit: number, credit: number): JournalLine => ({ id, journalEntryId, accountId, debit, credit, originalDebit: debit, originalCredit: credit })

const entries = [entry('invoice', 'INVOICE', 200), entry('payment-partial', 'PAYMENT', 80), entry('expense', 'EXPENSE', 50)]
const lines = [
  line('1', 'invoice', 'ar', 200, 0), line('2', 'invoice', 'revenue', 0, 200),
  line('3', 'payment-partial', 'cash', 80, 0), line('4', 'payment-partial', 'ar', 0, 80),
  line('5', 'expense', 'expense', 50, 0), line('6', 'expense', 'cash', 0, 50),
]

test('USD 200 invoice plus USD 200 payment does not double-count revenue', () => {
  const fullPayment = entry('payment-full', 'PAYMENT', 200)
  const fullLines = [line('7', 'payment-full', 'cash', 200, 0), line('8', 'payment-full', 'ar', 0, 200)]
  const dataset = { accounts, entries: [entries[0], fullPayment], lines: [...lines.slice(0, 2), ...fullLines] }
  assert.equal(incomeStatement(dataset).totalRevenue, 200)
  assert.equal(trialBalance(dataset).find(row => row.account.code === '1100')?.balance, 0)
})

test('partial payment leaves Accounts Receivable reconciled at USD 120', () => {
  const dataset = { accounts, entries: entries.slice(0, 2), lines: lines.slice(0, 4) }
  assert.equal(trialBalance(dataset).find(row => row.account.code === '1100')?.balance, 120)
  assert.equal(cashFlow(dataset).customerReceipts, 80)
})

test('expense posting reduces cash and yields correct net profit', () => {
  const dataset = { accounts, entries, lines }
  const statement = incomeStatement(dataset)
  assert.equal(statement.totalRevenue, 200)
  assert.equal(statement.totalExpenses, 50)
  assert.equal(statement.netProfit, 150)
  assert.equal(cashFlow(dataset).expensePayments, 50)
})

test('company-expense cargo charges are included in operating cash outflow', () => {
  const extraCharge = entry('charge-expense', 'EXTRA_CHARGE', 35)
  const extraLines = [
    line('extra-1', 'charge-expense', 'expense', 35, 0),
    line('extra-2', 'charge-expense', 'cash', 0, 35),
  ]
  const dataset = { accounts, entries: [extraCharge], lines: extraLines }
  assert.equal(incomeStatement(dataset).totalExpenses, 35)
  assert.equal(cashFlow(dataset).expensePayments, 35)
})

test('billable charges increase customer total due while company expenses do not', () => {
  const summary = shipmentFinancialSummary(200, 50, [
    { amount: 30, direction: 'billable_to_customer' },
    { amount: 40, direction: 'company_expense' },
  ])
  assert.equal(summary.totalDue, 230)
  assert.equal(summary.balance, 180)
  assert.equal(summary.companyExpenses, 40)
  assert.equal(summary.paymentStatus, 'Partially Paid')
})

test('multiple payments drive explicit payment status transitions', () => {
  assert.equal(shipmentFinancialSummary(200, 0, []).paymentStatus, 'Unpaid')
  assert.equal(shipmentFinancialSummary(200, 80, []).paymentStatus, 'Partially Paid')
  assert.equal(shipmentFinancialSummary(200, 200, []).paymentStatus, 'Paid')
  assert.equal(shipmentFinancialSummary(200, 80 + 70, [{ amount: 25, direction: 'billable_to_customer' }]).balance, 75)
})

test('existing shipment-linked expenses only affect the company expense subtotal', () => {
  const summary = shipmentFinancialSummary(100, 25, [{ amount: 10, direction: 'company_expense' }], 15)
  assert.equal(summary.totalDue, 100)
  assert.equal(summary.balance, 75)
  assert.equal(summary.companyExpenses, 25)
})

test('every journal is balanced and the accounting equation holds', () => {
  assert.equal(journalIsBalanced(lines.slice(0, 2)), true)
  const dataset = { accounts, entries, lines }
  assert.equal(reportIntegrity(dataset).debitsEqualCredits, true)
  assert.equal(balanceSheet(dataset).difference, 0)
  assert.equal(reportIntegrity(dataset).accountingEquationHolds, true)
})

test('historical FX snapshots convert transaction currency to reporting USD', () => {
  assert.equal(reportingAmount('TZS', 520000, 2600), 200)
  assert.equal(reportingAmount('AED', 734.5, 3.6725), 200)
  assert.throws(() => reportingAmount('TZS', 520000, 0), /exchange rate/i)
})

const rates: ExchangeRate[] = [
  { id: 'r1', rateDate: '2026-08-10', baseCurrency: 'USD', usdToTzs: 2600, usdToAed: 3.6725, source: 'MANUAL', createdAt: '2026-08-10T00:00:00Z', updatedAt: '2026-08-10T00:00:00Z' },
]

test('convertFromUsdBase multiplies the USD amount by the historical rate in force on the entry date', () => {
  assert.equal(convertFromUsdBase(200, 'TZS', '2026-08-10', rates).amount, 520000)
  assert.equal(convertFromUsdBase(200, 'AED', '2026-08-10', rates).amount, 734.5)
  assert.equal(convertFromUsdBase(200, 'USD', '2026-08-10', rates).amount, 200)
})

test('convertFromUsdBase flags a date with no applicable historical rate instead of guessing', () => {
  const result = convertFromUsdBase(200, 'TZS', '2020-01-01', rates)
  assert.equal(result.converted, false)
})

test('convertFromUsdBase treats a zero amount as trivially converted even with no rate on file', () => {
  assert.deepEqual(convertFromUsdBase(0, 'TZS', '2020-01-01', []), { amount: 0, converted: true })
})

test('convertDatasetToCurrency re-expresses every line in the target currency using its own entry date, never a blanket rate', () => {
  const dataset = { accounts, entries: entries.slice(0, 2), lines: lines.slice(0, 4) }
  const { dataset: converted, missingRateDates } = convertDatasetToCurrency(dataset, 'TZS', rates)
  assert.equal(missingRateDates.length, 0)
  // invoice line: USD 200 debit to AR -> TZS 520,000 at the 2026-08-10 rate
  assert.equal(converted.lines[0].debit, 520000)
  // USD amounts stay USD when the target currency is USD (no-op path)
  const usdPass = convertDatasetToCurrency(dataset, 'USD', rates)
  assert.deepEqual(usdPass.dataset, dataset)
})

test('convertDatasetToCurrency excludes and flags lines whose entry date has no applicable rate, rather than showing a wrong total', () => {
  const dataset = { accounts, entries: entries.slice(0, 2), lines: lines.slice(0, 4) }
  const { dataset: converted, missingRateDates } = convertDatasetToCurrency(dataset, 'TZS', [])
  assert.equal(converted.lines.length, 0)
  assert.deepEqual(missingRateDates, ['2026-08-15'])
})
