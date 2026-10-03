import { useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import Modal from '../components/Modal'
import PageHeader from '../components/PageHeader'
import { useAccountingStore } from '../store/useAccountingStore'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore, canAccess } from '../store/useAuthStore'
import { useRatesStore } from '../store/useRatesStore'
import { formatAmount } from '../types'
import type { Currency, ExchangeRate, ExchangeRatePolicy } from '../types'
import {
  accountLedger,
  balanceSheet,
  cashFlow,
  convertDatasetToCurrency,
  convertFromUsdBase,
  incomeStatement,
  reportIntegrity,
  revenueByShippingMethod,
  shipmentFinancialSummary,
  trialBalance,
  type ReportingCurrency,
} from '../lib/accounting'

type ReportCurrencyFilter = ReportingCurrency | 'ALL'

const REPORTS = [
  ['dashboard', 'Accounting Dashboard'], ['income-statement', 'Income Statement'],
  ['income', 'Income Report'], ['expenses', 'Expense Report'], ['balance-sheet', 'Balance Sheet'],
  ['cash-flow', 'Cash Flow'], ['trial-balance', 'Trial Balance'], ['ledger', 'General Ledger'],
  ['journals', 'Journal Entries'], ['receivables', 'Accounts Receivable'],
  ['customer-statement', 'Customer Statement'], ['payments', 'Payments Received'],
  ['outstanding', 'Outstanding Invoices'], ['shipping-revenue', 'Revenue AIR / SEA'],
  ['daily', 'Daily Report'], ['monthly', 'Monthly Report'],
] as const

type ReportId = typeof REPORTS[number][0]

export default function FinancialReports() {
  const { available, loaded, accounts, journalEntries, journalLines, createOtherIncome, voidEntry } = useAccountingStore()
  const { shipments, customers, payments, expenses, extraCharges, settings } = useAppStore()
  const currentUser = useAuthStore(state => state.currentUser)
  const exchangeRates = useRatesStore(state => state.exchangeRates)
  const [report, setReport] = useState<ReportId>('dashboard')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [reportingCurrency, setReportingCurrency] = useState<ReportCurrencyFilter>('USD')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [transactionType, setTransactionType] = useState('')
  const reportBodyRef = useRef<HTMLDivElement>(null)
  const [incomeOpen, setIncomeOpen] = useState(false)
  const [voidTarget, setVoidTarget] = useState('')
  const [voidReason, setVoidReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [incomeForm, setIncomeForm] = useState({ date: new Date().toISOString().slice(0, 10), description: '', amount: '', currency: 'USD' as Currency, exchangeRate: '1', reference: '', receivingAccountCode: '1010' as '1000' | '1010' })

  // journal_lines.debit/credit are always stored in USD (the accounting
  // base currency); everything downstream of `dataset` is USD. `conversionCurrency`
  // is the actual target passed to convertDatasetToCurrency — 'ALL' has no
  // meaningful single converted total (mixed original currencies can't be
  // summed), so it falls back to the USD base and relies on each report row's
  // own Original + Reporting Amount columns to show currency detail instead.
  const conversionCurrency: ReportingCurrency = reportingCurrency === 'ALL' ? 'USD' : reportingCurrency
  const dataset = useMemo(() => ({ accounts, entries: journalEntries, lines: journalLines }), [accounts, journalEntries, journalLines])
  const { dataset: displayDataset, missingRateDates } = useMemo(
    () => convertDatasetToCurrency(dataset, conversionCurrency, exchangeRates, settings.exchangeRatePolicy),
    [dataset, conversionCurrency, exchangeRates, settings.exchangeRatePolicy]
  )
  const statement = useMemo(() => incomeStatement(displayDataset, from || undefined, to || undefined), [displayDataset, from, to])
  const sheet = useMemo(() => balanceSheet(displayDataset, to || undefined), [displayDataset, to])
  const cash = useMemo(() => cashFlow(displayDataset, from || undefined, to || undefined), [displayDataset, from, to])
  // Ledger integrity is a structural health check (debits=credits, assets=
  // liabilities+equity) — always run on the raw USD dataset, never the
  // display-currency conversion, so per-line rounding from a currency
  // conversion can never register as a false integrity failure.
  const integrity = useMemo(() => reportIntegrity(dataset), [dataset])
  const shippingRevenue = useMemo(() => revenueByShippingMethod(displayDataset, from || undefined, to || undefined), [displayDataset, from, to])
  const scopedEntries = useMemo(() => journalEntries.filter(entry =>
    entry.status === 'POSTED' && (!from || entry.entryDate >= from) && (!to || entry.entryDate <= to)
    && (!transactionType || entry.referenceType === transactionType)
  ), [journalEntries, from, to, transactionType])
  const scopedEntryIds = useMemo(() => new Set(scopedEntries.map(entry => entry.id)), [scopedEntries])
  const accountById = useMemo(() => new Map(accounts.map(account => [account.id, account])), [accounts])
  const entryById = useMemo(() => new Map(journalEntries.map(entry => [entry.id, entry])), [journalEntries])
  const customerById = useMemo(() => new Map(customers.map(customer => [customer.id, customer])), [customers])
  const shipmentById = useMemo(() => new Map(shipments.map(shipment => [shipment.id, shipment])), [shipments])
  const selectedAccountId = accountId || accounts[0]?.id || ''
  const ledger = useMemo(() => selectedAccountId ? accountLedger(displayDataset, selectedAccountId, from || undefined, to || undefined) : [], [displayDataset, selectedAccountId, from, to])
  const trial = useMemo(() => {
    const scopedDisplayLines = displayDataset.lines.filter(line => scopedEntryIds.has(line.journalEntryId))
    const rows = trialBalance({ ...displayDataset, entries: scopedEntries, lines: scopedDisplayLines })
    return accountId ? rows.filter(row => row.account.id === accountId) : rows
  }, [displayDataset, scopedEntries, scopedEntryIds, accountId])
  const scopedPayments = useMemo(() => payments.filter(payment =>
    (payment.status === 'POSTED' || payment.status === undefined) && (!from || payment.date >= from) && (!to || payment.date <= to)
    && (!paymentMethod || payment.method === paymentMethod)
  ), [payments, from, to, paymentMethod])
  const scopedExpenses = useMemo(() => expenses.filter(expense => expense.status !== 'VOIDED' && (!from || expense.date >= from) && (!to || expense.date <= to)), [expenses, from, to])
  const receivables = useMemo(() => shipments.map(shipment => {
    const financial = shipmentFinancialSummary(
      shipment.invoiceAmount ?? shipment.totalAmount,
      shipment.amountPaid,
      extraCharges.filter(charge => charge.shipmentId === shipment.id && charge.status === 'ACTIVE'),
    )
    return { shipment, invoice: financial.totalDue, paid: financial.amountPaid, balance: Math.max(0, financial.balance), customer: customerById.get(shipment.customerId) }
  }).filter(row => row.balance > 0.005 && (!customerId || row.shipment.customerId === customerId)), [shipments, extraCharges, customerById, customerId])
  const paymentMethods = useMemo(() => [...new Set(payments.map(payment => payment.method).filter(Boolean))].sort(), [payments])
  const transactionTypes = useMemo(() => [...new Set(journalEntries.map(entry => entry.referenceType).filter(Boolean))].sort(), [journalEntries])

  const periodRows = useMemo(() => {
    const monthly = report === 'monthly'
    const values = new Map<string, { revenue: number; expense: number }>()
    for (const line of displayDataset.lines.filter(line => scopedEntryIds.has(line.journalEntryId))) {
      const entry = entryById.get(line.journalEntryId)
      const account = accountById.get(line.accountId)
      if (!entry || !account) continue
      const key = monthly ? entry.entryDate.slice(0, 7) : entry.entryDate
      const row = values.get(key) ?? { revenue: 0, expense: 0 }
      if (account.accountType === 'REVENUE') row.revenue += line.credit - line.debit
      if (account.accountType === 'EXPENSE') row.expense += line.debit - line.credit
      values.set(key, row)
    }
    return [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, row]) => ({ period, ...row, profit: row.revenue - row.expense }))
  }, [report, displayDataset, scopedEntryIds, entryById, accountById])

  async function saveOtherIncome() {
    const amount = Number(incomeForm.amount)
    const exchangeRate = Number(incomeForm.exchangeRate)
    if (!incomeForm.description.trim() || amount <= 0 || exchangeRate <= 0) return toast.error('Description, amount and historical exchange rate are required.')
    setSaving(true)
    try {
      await createOtherIncome({ date: incomeForm.date, incomeAccountCode: '4090', receivingAccountCode: incomeForm.receivingAccountCode, description: incomeForm.description.trim(), amount, currency: incomeForm.currency, exchangeRate, reference: incomeForm.reference || undefined })
      toast.success('Other income posted to the ledger.')
      setIncomeOpen(false)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Other income could not be posted.') }
    finally { setSaving(false) }
  }

  async function confirmVoid() {
    if (!voidTarget || !voidReason.trim()) return toast.error('A correction reason is required.')
    setSaving(true)
    try { await voidEntry(voidTarget, voidReason); toast.success('Journal entry voided with an audit reversal.'); setVoidTarget(''); setVoidReason('') }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Journal entry could not be voided.') }
    finally { setSaving(false) }
  }

  if (!canAccess(currentUser?.role, 'reports')) return <div className="app-page"><div className="rounded-2xl border border-red-200 bg-red-50 p-6"><h2 className="font-bold text-red-900">Access restricted</h2><p className="mt-2 text-sm text-red-800">Financial reports require Manager or Admin access.</p></div></div>
  if (!loaded) return <div className="app-page"><div className="loading-state"><span className="brand-spinner" /><span>Loading accounting ledger</span></div></div>
  if (!available) return <div className="app-page"><PageHeader title="Financial Reports" description="Ledger-backed accounting" /><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h2 className="font-bold text-amber-950">Accounting migration pending</h2><p className="mt-2 max-w-3xl text-sm text-amber-900">The reporting UI is ready, but the accounting tables are not available in this database. Apply the reviewed migration to the intended non-production environment before functional DB testing. Existing invoices, payments, expenses and cargo data remain untouched.</p></div></div>

  const title = REPORTS.find(([id]) => id === report)?.[1] ?? 'Financial Reports'
  const generatedAt = new Date().toLocaleString()
  const currencyLabel = reportingCurrency === 'ALL' ? 'All Currencies (base ledger shown in USD)' : reportingCurrency

  function resetFilters() {
    setFrom(''); setTo(''); setCustomerId(''); setAccountId(''); setReportingCurrency('USD'); setPaymentMethod(''); setTransactionType('')
  }

  function exportCsv() {
    const table = reportBodyRef.current?.querySelector('table')
    if (!table) { toast.error('This report has no table to export.'); return }
    const csvRows = [...table.querySelectorAll('tr')].map(tr =>
      [...tr.querySelectorAll('th,td')].map(cell => `"${(cell.textContent || '').replace(/"/g, '""').trim()}"`).join(',')
    )
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${title.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return <div className="app-page print:bg-white">
    <PageHeader title="Financial Reports" description="Posted journals are the source of truth" action={<div className="flex gap-2 print:hidden"><button onClick={() => setIncomeOpen(true)} className="secondary-button">Other Income</button><button onClick={exportCsv} className="secondary-button">Export Excel (CSV)</button><button onClick={() => window.print()} className="primary-button">Print / Export PDF</button></div>} />

    <div className="mb-5 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 print:hidden xl:grid-cols-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 xl:col-span-4">
        <select value={report} onChange={event => setReport(event.target.value as ReportId)} className="form-input"><option disabled>Choose report</option>{REPORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <input type="date" aria-label="From date" value={from} onChange={event => setFrom(event.target.value)} className="form-input" />
        <input type="date" aria-label="To date" value={to} onChange={event => setTo(event.target.value)} className="form-input" />
        <select value={reportingCurrency} onChange={event => setReportingCurrency(event.target.value as ReportCurrencyFilter)} aria-label="Reporting currency" className="form-input"><option value="USD">USD</option><option value="TZS">TZS</option><option value="AED">AED</option><option value="ALL">All Currencies</option></select>
        <select value={customerId} onChange={event => setCustomerId(event.target.value)} className="form-input"><option value="">All Customers</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.company || customer.name}</option>)}</select>
        <select value={accountId} onChange={event => setAccountId(event.target.value)} className="form-input"><option value="">All Accounts</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select>
        <select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)} className="form-input"><option value="">All Payment Methods</option>{paymentMethods.map(method => <option key={method} value={method}>{method}</option>)}</select>
        <select value={transactionType} onChange={event => setTransactionType(event.target.value)} className="form-input"><option value="">All Transaction Types</option>{transactionTypes.map(type => <option key={type} value={type}>{type}</option>)}</select>
      </div>
      <div className="flex gap-2 xl:col-span-4">
        <button onClick={resetFilters} className="secondary-button">Reset Filters</button>
        <span className="self-center text-xs text-slate-400">Filters apply immediately — no separate "Apply" step needed.</span>
      </div>
    </div>

    {missingRateDates.length > 0 && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
      {missingRateDates.length} transaction date{missingRateDates.length === 1 ? '' : 's'} could not be converted to {reportingCurrency} — missing exchange rate for {missingRateDates.slice(0, 5).join(', ')}{missingRateDates.length > 5 ? `, +${missingRateDates.length - 5} more` : ''}. Those entries are excluded from the totals below. Add the missing historical rate(s) in Settings to include them.
    </div>}

    <section className="premium-card overflow-hidden print:border-0 print:shadow-none">
      <header className="border-b border-slate-100 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-cargo-600">{settings.companyName}</div>
            <h2 className="mt-1 text-xl font-bold text-slate-900">{title}</h2>
            <p className="mt-1 text-xs text-slate-500">Period: {from || 'Beginning'} to {to || 'Today'} · Posted entries only</p>
          </div>
          <div className="text-right text-[11px] text-slate-500">
            <div>Reporting Currency: <strong className="text-slate-700">{currencyLabel}</strong></div>
            <div>Generated: {generatedAt}</div>
            <div>Prepared By: {currentUser?.name || 'System'}</div>
          </div>
        </div>
      </header>
      <div className="p-4 sm:p-5" ref={reportBodyRef}>
        {report === 'dashboard' && <DashboardCards statement={statement} sheet={sheet} cash={cash} receivable={convertFromUsdBase(receivables.reduce((sum, row) => sum + invoiceBalanceUsd(row.shipment, row.balance), 0), conversionCurrency, new Date().toISOString().slice(0, 10), exchangeRates, settings.exchangeRatePolicy).amount} integrity={integrity} currency={conversionCurrency} />}
        {report === 'income-statement' && <StatementTable statement={statement} currency={conversionCurrency} />}
        {report === 'income' && <JournalTable entries={scopedEntries.filter(entry => ['INVOICE', 'OTHER_INCOME'].includes(entry.referenceType))} currency={conversionCurrency} exchangeRates={exchangeRates} policy={settings.exchangeRatePolicy} />}
        {report === 'expenses' && <ExpenseTable rows={scopedExpenses} currency={conversionCurrency} exchangeRates={exchangeRates} policy={settings.exchangeRatePolicy} />}
        {report === 'balance-sheet' && <BalanceSheetTable sheet={sheet} currency={conversionCurrency} />}
        {report === 'cash-flow' && <SimpleRows currency={conversionCurrency} rows={[['Customer receipts', cash.customerReceipts], ['Other income receipts', cash.otherIncome], ['Expense payments', -cash.expensePayments], ['Net operating cash', cash.netOperatingCash]]} />}
        {report === 'trial-balance' && <AccountTable rows={trial} currency={conversionCurrency} />}
        {report === 'ledger' && <><select value={selectedAccountId} onChange={event => setAccountId(event.target.value)} className="form-input mb-4 max-w-sm print:hidden">{accounts.map(account => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select><LedgerTable rows={ledger} currency={conversionCurrency} /></>}
        {report === 'journals' && <JournalTable entries={scopedEntries} onVoid={entryId => { setVoidTarget(entryId); setVoidReason('') }} currency={conversionCurrency} exchangeRates={exchangeRates} policy={settings.exchangeRatePolicy} />}
        {(report === 'receivables' || report === 'outstanding') && <ReceivablesTable rows={receivables} />}
        {report === 'customer-statement' && <CustomerStatement customerId={customerId} shipments={shipments} payments={scopedPayments} customers={customers} extraCharges={extraCharges} />}
        {report === 'payments' && <PaymentsTable rows={scopedPayments} shipmentById={shipmentById} currency={conversionCurrency} exchangeRates={exchangeRates} policy={settings.exchangeRatePolicy} />}
        {report === 'shipping-revenue' && <SimpleRows currency={conversionCurrency} rows={[['AIR revenue', shippingRevenue.air], ['SEA revenue', shippingRevenue.sea], ['Other revenue', shippingRevenue.other], ['Total revenue', shippingRevenue.total]]} />}
        {(report === 'daily' || report === 'monthly') && <PeriodTable rows={periodRows} currency={conversionCurrency} />}
      </div>
    </section>

    <Modal open={incomeOpen} onClose={() => setIncomeOpen(false)} title="Post Other Income"><div className="space-y-3"><input type="date" value={incomeForm.date} onChange={event => setIncomeForm(form => ({ ...form, date: event.target.value }))} className="form-input" /><input placeholder="Income description" value={incomeForm.description} onChange={event => setIncomeForm(form => ({ ...form, description: event.target.value }))} className="form-input" /><div className="grid grid-cols-2 gap-3"><input type="number" min="0.01" placeholder="Amount" value={incomeForm.amount} onChange={event => setIncomeForm(form => ({ ...form, amount: event.target.value }))} className="form-input" /><select value={incomeForm.currency} onChange={event => setIncomeForm(form => ({ ...form, currency: event.target.value as Currency, exchangeRate: event.target.value === 'USD' ? '1' : form.exchangeRate }))} className="form-input">{(['USD', 'TZS', 'AED'] as Currency[]).map(currency => <option key={currency}>{currency}</option>)}</select></div><input type="number" min="0.000001" value={incomeForm.exchangeRate} onChange={event => setIncomeForm(form => ({ ...form, exchangeRate: event.target.value }))} className="form-input" placeholder="Currency units per USD on transaction date" /><select value={incomeForm.receivingAccountCode} onChange={event => setIncomeForm(form => ({ ...form, receivingAccountCode: event.target.value as '1000' | '1010' }))} className="form-input"><option value="1010">Bank</option><option value="1000">Cash</option></select><input placeholder="Reference (optional)" value={incomeForm.reference} onChange={event => setIncomeForm(form => ({ ...form, reference: event.target.value }))} className="form-input" /><button disabled={saving} onClick={saveOtherIncome} className="primary-button w-full">{saving ? 'Posting…' : 'Post Other Income'}</button></div></Modal>
    <Modal open={Boolean(voidTarget)} onClose={() => setVoidTarget('')} title="Void Posted Journal"><div className="space-y-3"><p className="text-sm text-slate-600">The posted record will be retained and paired with an auditable reversal. It cannot be deleted.</p><textarea value={voidReason} onChange={event => setVoidReason(event.target.value)} rows={3} placeholder="Required correction reason" className="form-input resize-none" /><div className="grid grid-cols-2 gap-2"><button onClick={() => setVoidTarget('')} className="secondary-button">Cancel</button><button disabled={saving || !voidReason.trim()} onClick={confirmVoid} className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Voiding…' : 'Void Entry'}</button></div></div></Modal>
  </div>
}

function invoiceBalanceUsd(shipment: ReturnType<typeof useAppStore.getState>['shipments'][number], balance: number) { const currency = shipment.invoiceCurrency ?? shipment.currency; if (currency === 'USD') return balance; const rate = currency === 'TZS' ? shipment.usdToTzsRateUsed : shipment.usdToAedRateUsed; return rate && rate > 0 ? balance / rate : 0 }

// Every amount reaching these presentational components has already been
// converted to the selected reporting currency upstream (via
// convertDatasetToCurrency / convertFromUsdBase) — `currency` here is only
// used to pick the right symbol/format, never to convert again.
function DashboardCards({ statement, sheet, cash, receivable, integrity, currency }: { statement: ReturnType<typeof incomeStatement>; sheet: ReturnType<typeof balanceSheet>; cash: ReturnType<typeof cashFlow>; receivable: number; integrity: ReturnType<typeof reportIntegrity>; currency: ReportingCurrency }) { const cards = [['Revenue', statement.totalRevenue], ['Expenses', statement.totalExpenses], ['Net Profit', statement.netProfit], ['Cash Movement', cash.netOperatingCash], ['Receivables', receivable], ['Total Assets', sheet.totalAssets]] as const; return <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{cards.map(([label, value]) => <div key={label} className="rounded-xl border border-slate-200 p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div><div className="mt-2 text-xl font-bold text-slate-900">{formatAmount(value, currency)}</div></div>)}</div><div className={`mt-4 rounded-xl border p-4 text-sm ${integrity.debitsEqualCredits && integrity.accountingEquationHolds ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`}>Ledger integrity (always checked in USD base): debits = credits <strong>{integrity.debitsEqualCredits ? 'PASS' : 'FAIL'}</strong> · assets = liabilities + equity <strong>{integrity.accountingEquationHolds ? 'PASS' : 'FAIL'}</strong></div></> }
function SimpleRows({ rows, currency }: { rows: readonly (readonly [string, number])[]; currency: ReportingCurrency }) { return <div className="divide-y divide-slate-100">{rows.map(([label, value], index) => <div key={label} className={`flex justify-between gap-4 py-3 ${index === rows.length - 1 ? 'font-bold border-t border-slate-200 mt-1 pt-3' : ''}`}><span>{label}</span><span>{formatAmount(value, currency)}</span></div>)}</div> }
function StatementTable({ statement, currency }: { statement: ReturnType<typeof incomeStatement>; currency: ReportingCurrency }) {
  // 4090 "Other Income" is its own seeded account (see 20260815013917_double_entry_accounting.sql),
  // distinct from cargo/service revenue by code — splitting on it is reading
  // an existing category, not inventing one. No COGS/Gross Profit or
  // "Other Expenses" section is rendered: no cost-of-sales account subtype
  // or non-operating-expense account exists in the schema, and the brief is
  // explicit not to invent categories that aren't in the database.
  const otherIncome = statement.revenue.filter(row => row.account.code === '4090')
  const operatingRevenue = statement.revenue.filter(row => row.account.code !== '4090')
  const totalOperatingRevenue = operatingRevenue.reduce((sum, row) => sum + row.amount, 0)
  const totalOtherIncome = otherIncome.reduce((sum, row) => sum + row.amount, 0)
  const operatingProfit = totalOperatingRevenue - statement.totalExpenses
  return <div className="space-y-6">
    <div><h3 className="font-bold text-slate-900">Revenue</h3><SimpleRows currency={currency} rows={[...operatingRevenue.map(row => [row.account.name, row.amount] as const), ['Total Revenue', totalOperatingRevenue]]} /></div>
    <div><h3 className="font-bold text-slate-900">Operating Expenses</h3><SimpleRows currency={currency} rows={[...statement.expenses.map(row => [row.account.name, row.amount] as const), ['Total Operating Expenses', statement.totalExpenses]]} /></div>
    <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm font-bold flex justify-between"><span>Operating Profit</span><span>{formatAmount(operatingProfit, currency)}</span></div>
    {otherIncome.length > 0 && <div><h3 className="font-bold text-slate-900">Other Income</h3><SimpleRows currency={currency} rows={[...otherIncome.map(row => [row.account.name, row.amount] as const), ['Total Other Income', totalOtherIncome]]} /></div>}
    <div className="rounded-lg bg-slate-900 px-3 py-2.5 text-sm font-bold text-white flex justify-between"><span>Net Profit</span><span>{formatAmount(statement.netProfit, currency)}</span></div>
  </div>
}
function BalanceSheetTable({ sheet, currency }: { sheet: ReturnType<typeof balanceSheet>; currency: ReportingCurrency }) {
  // No Current/Non-current split: accounting_accounts has no asset/liability
  // subtype column to split on, and the brief says not to fabricate one.
  return <div className="grid gap-6 lg:grid-cols-2">
    <div><h3 className="font-bold">Assets</h3><SimpleRows currency={currency} rows={[...sheet.assets.map(row => [row.account.name, row.amount] as const), ['Total Assets', sheet.totalAssets]]} /></div>
    <div><h3 className="font-bold">Liabilities & Equity</h3><SimpleRows currency={currency} rows={[...sheet.liabilities.map(row => [row.account.name, row.amount] as const), ['Total Liabilities', sheet.totalLiabilities], ...sheet.equityAccounts.map(row => [row.account.name, row.amount] as const), ['Current Period Profit', sheet.currentProfit], ['Total Equity', sheet.totalEquity], ['Total Liabilities & Equity', sheet.totalLiabilities + sheet.totalEquity]]} /></div>
  </div>
}
function AccountTable({ rows, currency }: { rows: ReturnType<typeof trialBalance>; currency: ReportingCurrency }) { return <ReportTable headers={['Code', 'Account', 'Debit', 'Credit', 'Balance']} rows={rows.filter(row => row.debit || row.credit).map(row => [row.account.code, row.account.name, formatAmount(row.debit, currency), formatAmount(row.credit, currency), formatAmount(row.balance, currency)])} /> }

// Reporting Amount here is computed per-row (not from the pre-converted
// display dataset) because these rows come from raw scoped
// entries/payments/expenses, each on its own transaction date — exactly
// the "convert using this transaction's own historical rate" rule.
function reportingCell(amountUsd: number, date: string, currency: ReportingCurrency, exchangeRates: ExchangeRate[], policy: ExchangeRatePolicy) {
  const conv = convertFromUsdBase(amountUsd, currency, date, exchangeRates, policy)
  return conv.converted ? formatAmount(conv.amount, currency) : 'No rate for date'
}
function JournalTable({ entries, onVoid, currency, exchangeRates, policy }: { entries: ReturnType<typeof useAccountingStore.getState>['journalEntries']; onVoid?: (entryId: string) => void; currency: ReportingCurrency; exchangeRates: ExchangeRate[]; policy: ExchangeRatePolicy }) { return <ReportTable headers={['Entry', 'Date', 'Description', 'Type', 'Original (Transaction Currency)', `Reporting Amount (${currency})`, ...(onVoid ? ['Action'] : [])]} rows={entries.map(entry => [entry.entryNumber, entry.entryDate, entry.description, entry.referenceType, `${entry.currency} ${entry.originalAmount.toLocaleString()}`, reportingCell(entry.baseAmount, entry.entryDate, currency, exchangeRates, policy), ...(onVoid ? [<button key={entry.id} onClick={() => onVoid(entry.id)} className="rounded-lg border border-red-200 px-2 py-1 text-xs font-bold text-red-600 print:hidden">Void</button>] : [])])} /> }
function LedgerTable({ rows, currency }: { rows: ReturnType<typeof accountLedger>; currency: ReportingCurrency }) { return <ReportTable headers={['Date', 'Entry', 'Description', 'Debit', 'Credit', 'Running Balance']} rows={rows.map(row => [row.entry.entryDate, row.entry.entryNumber, row.line.description || row.entry.description, formatAmount(row.line.debit, currency), formatAmount(row.line.credit, currency), formatAmount(row.runningBalance, currency)])} /> }
function ExpenseTable({ rows, currency, exchangeRates, policy }: { rows: ReturnType<typeof useAppStore.getState>['expenses']; currency: ReportingCurrency; exchangeRates: ExchangeRate[]; policy: ExchangeRatePolicy }) { return <ReportTable headers={['Number', 'Date', 'Payee / Description', 'Category', 'Original (Transaction Currency)', `Reporting Amount (${currency})`, 'Status']} rows={rows.map(row => [row.expenseNumber || '—', row.date, row.payee || row.description, row.category, `${row.currency} ${row.amount.toLocaleString()}`, reportingCell(row.reportingAmount ?? 0, row.date, currency, exchangeRates, policy), row.status || 'LEGACY'])} /> }
function PaymentsTable({ rows, shipmentById, currency, exchangeRates, policy }: { rows: ReturnType<typeof useAppStore.getState>['payments']; shipmentById: Map<string, ReturnType<typeof useAppStore.getState>['shipments'][number]>; currency: ReportingCurrency; exchangeRates: ExchangeRate[]; policy: ExchangeRatePolicy }) { return <ReportTable headers={['Receipt', 'Date', 'Shipment', 'Method', 'Original (Transaction Currency)', `Reporting Amount (${currency})`, 'Status']} rows={rows.map(row => [row.receiptNumber, row.date, (row.shipmentId && shipmentById.get(row.shipmentId)?.trackingNumber) || row.shipmentTrackingSnapshot || '—', row.method, `${row.currency} ${row.amount.toLocaleString()}`, reportingCell(row.reportingAmount ?? 0, row.date, currency, exchangeRates, policy), row.status || 'LEGACY'])} /> }
function ReceivablesTable({ rows }: { rows: Array<{ shipment: ReturnType<typeof useAppStore.getState>['shipments'][number]; invoice: number; paid: number; balance: number; customer: ReturnType<typeof useAppStore.getState>['customers'][number] | undefined }> }) { return <ReportTable headers={['Tracking', 'Customer', 'Invoice', 'Paid', 'Outstanding', 'Currency']} rows={rows.map(row => [row.shipment.trackingNumber, row.customer?.company || row.customer?.name || '—', row.invoice.toLocaleString(), row.paid.toLocaleString(), row.balance.toLocaleString(), row.shipment.invoiceCurrency ?? row.shipment.currency])} /> }
function CustomerStatement({ customerId, shipments, payments, customers, extraCharges }: { customerId: string; shipments: ReturnType<typeof useAppStore.getState>['shipments']; payments: ReturnType<typeof useAppStore.getState>['payments']; customers: ReturnType<typeof useAppStore.getState>['customers']; extraCharges: ReturnType<typeof useAppStore.getState>['extraCharges'] }) { if (!customerId) return <p className="py-10 text-center text-sm text-slate-500">Select a customer to generate a statement.</p>; const customer = customers.find(item => item.id === customerId); const customerShipments = shipments.filter(item => item.customerId === customerId); const ids = new Set(customerShipments.map(item => item.id)); const rows = [...customerShipments.map(item => ({ date: item.createdAt.slice(0, 10), ref: item.trackingNumber, description: 'Invoice and billable cargo charges', amount: shipmentFinancialSummary(item.invoiceAmount ?? item.totalAmount, item.amountPaid, extraCharges.filter(charge => charge.shipmentId === item.id && charge.status === 'ACTIVE')).totalDue, currency: item.invoiceCurrency ?? item.currency })), ...payments.filter(item => item.shipmentId && ids.has(item.shipmentId)).map(item => ({ date: item.date, ref: item.receiptNumber, description: 'Payment received', amount: -item.amount, currency: item.currency }))].sort((a, b) => a.date.localeCompare(b.date)); return <><div className="mb-4 font-bold text-slate-900">{customer?.company || customer?.name}</div><ReportTable headers={['Date', 'Reference', 'Description', 'Amount', 'Currency']} rows={rows.map(row => [row.date, row.ref, row.description, row.amount.toLocaleString(), row.currency])} /></> }
function PeriodTable({ rows, currency }: { rows: Array<{ period: string; revenue: number; expense: number; profit: number }>; currency: ReportingCurrency }) { return <ReportTable headers={['Period', 'Revenue', 'Expense', 'Profit']} rows={rows.map(row => [row.period, formatAmount(row.revenue, currency), formatAmount(row.expense, currency), formatAmount(row.profit, currency)])} /> }
function ReportTable({ headers, rows }: { headers: string[]; rows: Array<Array<React.ReactNode>> }) { return <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm"><thead><tr className="border-b bg-slate-50">{headers.map(header => <th key={header} className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">{header}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.map((row, index) => <tr key={String(row[0]) + index}>{row.map((cell, cellIndex) => <td key={cellIndex} className={`px-3 py-2.5 ${cellIndex >= row.length - 2 ? 'tabular-nums' : ''}`}>{cell}</td>)}</tr>)}{!rows.length && <tr><td colSpan={headers.length} className="py-10 text-center text-slate-400">No posted records for this selection.</td></tr>}</tbody></table></div> }
