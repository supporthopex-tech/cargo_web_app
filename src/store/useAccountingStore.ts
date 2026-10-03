import { create } from 'zustand'
import { supabase } from '../lib/supabase'
import type {
  AccountingAccount,
  Currency,
  JournalEntry,
  JournalLine,
  OtherIncome,
} from '../types'

function mapAccount(row: any): AccountingAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    normalBalance: row.normal_balance,
    parentId: row.parent_id ?? undefined,
    active: Boolean(row.active),
    systemAccount: Boolean(row.system_account),
    allowManualPosting: Boolean(row.allow_manual_posting),
  }
}

function mapEntry(row: any): JournalEntry {
  return {
    id: row.id,
    entryNumber: row.entry_number,
    entryDate: row.entry_date,
    description: row.description,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    currency: row.currency,
    exchangeRate: Number(row.exchange_rate),
    originalAmount: Number(row.original_amount),
    baseAmount: Number(row.base_amount),
    status: row.status,
    reversalOf: row.reversal_of ?? undefined,
    correctionReason: row.correction_reason ?? undefined,
    createdBy: row.created_by ?? undefined,
    postedBy: row.posted_by ?? undefined,
    createdAt: row.created_at,
    postedAt: row.posted_at ?? undefined,
  }
}

function mapLine(row: any): JournalLine {
  return {
    id: row.id,
    journalEntryId: row.journal_entry_id,
    accountId: row.account_id,
    description: row.description ?? undefined,
    debit: Number(row.debit),
    credit: Number(row.credit),
    originalDebit: Number(row.original_debit),
    originalCredit: Number(row.original_credit),
  }
}

function mapOtherIncome(row: any): OtherIncome {
  return {
    id: row.id,
    incomeNumber: row.income_number,
    incomeDate: row.income_date,
    incomeAccountId: row.income_account_id,
    receivingAccountId: row.receiving_account_id,
    description: row.description,
    amount: Number(row.amount),
    currency: row.currency,
    exchangeRate: Number(row.exchange_rate),
    reportingAmount: Number(row.reporting_amount),
    reference: row.reference ?? undefined,
    status: row.status,
    accountingJournalEntryId: row.accounting_journal_entry_id ?? undefined,
    createdBy: row.created_by,
  }
}

interface OtherIncomeInput {
  date: string
  incomeAccountCode: string
  receivingAccountCode: '1000' | '1010'
  description: string
  amount: number
  currency: Currency
  exchangeRate: number
  reference?: string
}

interface AccountingState {
  available: boolean
  loaded: boolean
  accounts: AccountingAccount[]
  journalEntries: JournalEntry[]
  journalLines: JournalLine[]
  otherIncome: OtherIncome[]
  loadAccounting: () => Promise<void>
  createOtherIncome: (input: OtherIncomeInput) => Promise<void>
  voidEntry: (entryId: string, reason: string) => Promise<void>
  setAccountActive: (accountId: string, active: boolean) => Promise<void>
}

export const useAccountingStore = create<AccountingState>()((set, get) => ({
  available: false,
  loaded: false,
  accounts: [],
  journalEntries: [],
  journalLines: [],
  otherIncome: [],

  loadAccounting: async () => {
    const [accounts, entries, lines, income] = await Promise.all([
      supabase.from('accounting_accounts').select('*').order('code'),
      supabase.from('journal_entries').select('*').order('entry_date', { ascending: false }).order('entry_number', { ascending: false }),
      supabase.from('journal_lines').select('*').order('created_at'),
      supabase.from('other_income').select('*').order('income_date', { ascending: false }),
    ])
    const unavailable = [accounts, entries, lines, income].some(result => result.error)
    if (unavailable) {
      set({ available: false, loaded: true, accounts: [], journalEntries: [], journalLines: [], otherIncome: [] })
      return
    }
    set({
      available: true,
      loaded: true,
      accounts: (accounts.data ?? []).map(mapAccount),
      journalEntries: (entries.data ?? []).map(mapEntry),
      journalLines: (lines.data ?? []).map(mapLine),
      otherIncome: (income.data ?? []).map(mapOtherIncome),
    })
  },

  createOtherIncome: async input => {
    const result = await supabase.rpc('create_other_income', {
      p_income_date: input.date,
      p_income_account_code: input.incomeAccountCode,
      p_receiving_account_code: input.receivingAccountCode,
      p_description: input.description,
      p_amount: input.amount,
      p_currency: input.currency,
      p_exchange_rate: input.exchangeRate,
      p_reference: input.reference ?? null,
    })
    if (result.error) throw new Error(result.error.message)
    await get().loadAccounting()
  },

  voidEntry: async (entryId, reason) => {
    if (!reason.trim()) throw new Error('A correction reason is required.')
    const result = await supabase.rpc('void_accounting_entry', { p_journal_entry_id: entryId, p_reason: reason.trim() })
    if (result.error) throw new Error(result.error.message)
    await get().loadAccounting()
  },

  setAccountActive: async (accountId, active) => {
    const account = get().accounts.find(item => item.id === accountId)
    if (!account) return
    if (account.systemAccount && !active) {
      throw new Error('Core system accounts cannot be disabled.')
    }
    const result = await supabase.from('accounting_accounts')
      .update({ active, updated_at: new Date().toISOString() })
      .eq('id', accountId)
      .select()
      .single()
    if (result.error) throw new Error(result.error.message)
    set(state => ({ accounts: state.accounts.map(item => item.id === accountId ? { ...item, active } : item) }))
  },
}))
