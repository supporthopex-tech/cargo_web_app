import type { AccountingAccount, ChargeDirection, ExchangeRate, ExchangeRatePolicy, JournalEntry, JournalLine, PaymentStatus } from '../types'
import { findApplicableExchangeRate } from './exchangeRateService.ts'

export interface AccountingDataset {
  accounts: AccountingAccount[]
  entries: JournalEntry[]
  lines: JournalLine[]
}

export interface AccountBalance {
  account: AccountingAccount
  debit: number
  credit: number
  balance: number
}

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

export interface FinancialChargeAmount {
  amount: number
  direction: ChargeDirection
}

export interface ShipmentFinancialSummary {
  baseShipmentCharges: number
  billableExtraCharges: number
  companyExpenseCharges: number
  existingCompanyExpenses: number
  totalExtraCharges: number
  totalDue: number
  amountPaid: number
  balance: number
  companyExpenses: number
  paymentStatus: PaymentStatus
}

/**
 * Single source of truth for the customer-facing shipment balance. Company
 * expenses are intentionally excluded from totalDue and paymentStatus.
 */
export function shipmentFinancialSummary(
  baseShipmentCharges: number,
  amountPaid: number,
  charges: FinancialChargeAmount[],
  existingCompanyExpenses = 0,
): ShipmentFinancialSummary {
  const billableExtraCharges = money(charges
    .filter(charge => charge.direction === 'billable_to_customer')
    .reduce((sum, charge) => sum + charge.amount, 0))
  const companyExpenseCharges = money(charges
    .filter(charge => charge.direction === 'company_expense')
    .reduce((sum, charge) => sum + charge.amount, 0))
  const totalDue = money(baseShipmentCharges + billableExtraCharges)
  const normalizedPaid = money(amountPaid)
  const balance = money(totalDue - normalizedPaid)
  const paymentStatus: PaymentStatus = normalizedPaid <= 0
    ? 'Unpaid'
    : normalizedPaid >= totalDue
      ? 'Paid'
      : 'Partially Paid'

  return {
    baseShipmentCharges: money(baseShipmentCharges),
    billableExtraCharges,
    companyExpenseCharges,
    existingCompanyExpenses: money(existingCompanyExpenses),
    totalExtraCharges: money(billableExtraCharges + companyExpenseCharges),
    totalDue,
    amountPaid: normalizedPaid,
    balance,
    companyExpenses: money(companyExpenseCharges + existingCompanyExpenses),
    paymentStatus,
  }
}

export function postedDataset(dataset: AccountingDataset, from?: string, to?: string): AccountingDataset {
  const entries = dataset.entries.filter(entry =>
    entry.status === 'POSTED' && (!from || entry.entryDate >= from) && (!to || entry.entryDate <= to)
  )
  const entryIds = new Set(entries.map(entry => entry.id))
  return { ...dataset, entries, lines: dataset.lines.filter(line => entryIds.has(line.journalEntryId)) }
}

export function trialBalance(dataset: AccountingDataset): AccountBalance[] {
  const posted = postedDataset(dataset)
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const line of posted.lines) {
    const current = totals.get(line.accountId) ?? { debit: 0, credit: 0 }
    current.debit += line.debit
    current.credit += line.credit
    totals.set(line.accountId, current)
  }
  return dataset.accounts.map(account => {
    const total = totals.get(account.id) ?? { debit: 0, credit: 0 }
    return { account, debit: money(total.debit), credit: money(total.credit), balance: money(total.debit - total.credit) }
  })
}

export function journalIsBalanced(lines: JournalLine[]): boolean {
  const debit = money(lines.reduce((sum, line) => sum + line.debit, 0))
  const credit = money(lines.reduce((sum, line) => sum + line.credit, 0))
  return debit > 0 && debit === credit
}

export function allPostedJournalsBalanced(dataset: AccountingDataset): boolean {
  return dataset.entries.filter(entry => entry.status === 'POSTED').every(entry =>
    journalIsBalanced(dataset.lines.filter(line => line.journalEntryId === entry.id))
  )
}

export function incomeStatement(dataset: AccountingDataset, from?: string, to?: string) {
  const balances = trialBalance(postedDataset(dataset, from, to))
  const revenue = balances.filter(item => item.account.accountType === 'REVENUE').map(item => ({
    ...item,
    amount: money(item.credit - item.debit),
  }))
  const expenses = balances.filter(item => item.account.accountType === 'EXPENSE').map(item => ({
    ...item,
    amount: money(item.debit - item.credit),
  }))
  const totalRevenue = money(revenue.reduce((sum, item) => sum + item.amount, 0))
  const totalExpenses = money(expenses.reduce((sum, item) => sum + item.amount, 0))
  return { revenue, expenses, totalRevenue, totalExpenses, netProfit: money(totalRevenue - totalExpenses) }
}

export function balanceSheet(dataset: AccountingDataset, asAt?: string) {
  const scoped = postedDataset(dataset, undefined, asAt)
  const balances = trialBalance(scoped)
  const assets = balances.filter(item => item.account.accountType === 'ASSET').map(item => ({ ...item, amount: money(item.debit - item.credit) }))
  const liabilities = balances.filter(item => item.account.accountType === 'LIABILITY').map(item => ({ ...item, amount: money(item.credit - item.debit) }))
  const equityAccounts = balances.filter(item => item.account.accountType === 'EQUITY').map(item => ({ ...item, amount: money(item.credit - item.debit) }))
  const currentProfit = incomeStatement(scoped).netProfit
  const totalAssets = money(assets.reduce((sum, item) => sum + item.amount, 0))
  const totalLiabilities = money(liabilities.reduce((sum, item) => sum + item.amount, 0))
  const accountEquity = money(equityAccounts.reduce((sum, item) => sum + item.amount, 0))
  const totalEquity = money(accountEquity + currentProfit)
  return {
    assets,
    liabilities,
    equityAccounts,
    currentProfit,
    totalAssets,
    totalLiabilities,
    totalEquity,
    difference: money(totalAssets - totalLiabilities - totalEquity),
  }
}

export function cashFlow(dataset: AccountingDataset, from?: string, to?: string) {
  const scoped = postedDataset(dataset, from, to)
  const cashAccountIds = new Set(dataset.accounts.filter(account => ['1000', '1010'].includes(account.code)).map(account => account.id))
  const byEntry = new Map(scoped.entries.map(entry => [entry.id, entry]))
  let customerReceipts = 0
  let otherIncome = 0
  let expensePayments = 0
  for (const line of scoped.lines) {
    if (!cashAccountIds.has(line.accountId)) continue
    const entry = byEntry.get(line.journalEntryId)
    if (!entry) continue
    const movement = line.debit - line.credit
    if (entry.referenceType === 'PAYMENT') customerReceipts += movement
    else if (entry.referenceType === 'OTHER_INCOME') otherIncome += movement
    else if (entry.referenceType === 'EXPENSE' || entry.referenceType === 'EXTRA_CHARGE') expensePayments += -movement
  }
  return {
    customerReceipts: money(customerReceipts),
    otherIncome: money(otherIncome),
    expensePayments: money(expensePayments),
    netOperatingCash: money(customerReceipts + otherIncome - expensePayments),
  }
}

export function accountLedger(dataset: AccountingDataset, accountId: string, from?: string, to?: string) {
  const scoped = postedDataset(dataset, from, to)
  const entries = new Map(scoped.entries.map(entry => [entry.id, entry]))
  let runningBalance = 0
  return scoped.lines
    .filter(line => line.accountId === accountId)
    .map(line => ({ line, entry: entries.get(line.journalEntryId)! }))
    .filter(row => Boolean(row.entry))
    .sort((a, b) => a.entry.entryDate.localeCompare(b.entry.entryDate) || a.entry.entryNumber.localeCompare(b.entry.entryNumber))
    .map(row => {
      runningBalance = money(runningBalance + row.line.debit - row.line.credit)
      return { ...row, runningBalance }
    })
}

export function revenueByShippingMethod(dataset: AccountingDataset, from?: string, to?: string) {
  const statement = incomeStatement(dataset, from, to)
  const amount = (code: string) => statement.revenue.find(item => item.account.code === code)?.amount ?? 0
  const air = amount('4000')
  const sea = amount('4010')
  const other = money(statement.totalRevenue - air - sea)
  return { air, sea, other, total: statement.totalRevenue }
}

export function reportIntegrity(dataset: AccountingDataset) {
  const trial = trialBalance(dataset)
  const totalDebit = money(trial.reduce((sum, item) => sum + item.debit, 0))
  const totalCredit = money(trial.reduce((sum, item) => sum + item.credit, 0))
  const sheet = balanceSheet(dataset)
  return {
    totalDebit,
    totalCredit,
    debitsEqualCredits: totalDebit === totalCredit && allPostedJournalsBalanced(dataset),
    accountingEquationHolds: Math.abs(sheet.difference) < 0.01,
  }
}

export function reportingAmount(currency: 'USD' | 'TZS' | 'AED', amount: number, exchangeRate: number): number {
  if (amount <= 0) throw new Error('Amount must be greater than zero.')
  if (currency === 'USD') return money(amount)
  if (exchangeRate <= 0) throw new Error('Historical exchange rate must be greater than zero.')
  return money(amount / exchangeRate)
}

export type ReportingCurrency = 'USD' | 'TZS' | 'AED'

/**
 * Converts a single USD-base amount (journal_lines.debit/credit are always
 * stored in USD, see accounting_reporting_amount() in
 * 20260815013917_double_entry_accounting.sql) into a display reporting
 * currency, using the historical rate that was in force on the entry's own
 * date — never today's rate. This is the inverse direction of
 * reportingAmount() above, which converts an original transaction currency
 * INTO the USD base at posting time; this converts the USD base OUT to a
 * reporting currency at read time, for display only. Nothing stored is
 * ever rewritten by this function.
 */
export function convertFromUsdBase(
  amountUsd: number,
  targetCurrency: ReportingCurrency,
  entryDate: string,
  exchangeRates: ExchangeRate[],
  policy: ExchangeRatePolicy = 'LATEST_APPROVED',
): { amount: number; converted: boolean } {
  if (targetCurrency === 'USD' || amountUsd === 0) return { amount: money(amountUsd), converted: true }
  const applicable = findApplicableExchangeRate(exchangeRates, entryDate, policy)
  if (!applicable) return { amount: 0, converted: false }
  const rate = targetCurrency === 'TZS' ? applicable.rate.usdToTzs : applicable.rate.usdToAed
  return { amount: money(amountUsd * rate), converted: true }
}

/**
 * Re-expresses an entire posted dataset in a reporting currency, line by
 * line, each using its own entry's historical rate — so aggregating after
 * conversion (trialBalance/incomeStatement/balanceSheet/etc., which all
 * already accept a plain AccountingDataset) is equivalent to converting
 * each transaction on its own date, not applying one blanket rate to a
 * pre-summed USD total. Lines whose entry date has no applicable
 * historical rate are dropped from the returned dataset (never shown as a
 * silently-wrong $0) and their entry dates are reported back so the UI can
 * warn which transactions could not be converted.
 */
export function convertDatasetToCurrency(
  dataset: AccountingDataset,
  targetCurrency: ReportingCurrency,
  exchangeRates: ExchangeRate[],
  policy: ExchangeRatePolicy = 'LATEST_APPROVED',
): { dataset: AccountingDataset; missingRateDates: string[] } {
  if (targetCurrency === 'USD') return { dataset, missingRateDates: [] }
  const entryById = new Map(dataset.entries.map(entry => [entry.id, entry]))
  const missing = new Set<string>()
  const lines: JournalLine[] = []
  for (const line of dataset.lines) {
    const entry = entryById.get(line.journalEntryId)
    if (!entry) continue
    const debitConv = convertFromUsdBase(line.debit, targetCurrency, entry.entryDate, exchangeRates, policy)
    const creditConv = convertFromUsdBase(line.credit, targetCurrency, entry.entryDate, exchangeRates, policy)
    if (!debitConv.converted || !creditConv.converted) { missing.add(entry.entryDate); continue }
    lines.push({ ...line, debit: debitConv.amount, credit: creditConv.amount })
  }
  return { dataset: { ...dataset, lines }, missingRateDates: [...missing].sort() }
}
