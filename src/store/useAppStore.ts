import { create } from 'zustand'
import toast from 'react-hot-toast'
import type {
  Customer, Shipment, PackingList, PaymentRecord, PaymentRefund,
  Expense, CompanySettings, ShipmentStatus, StatusEvent,
  PackingBox, PackingAllocation, StatusTransitionInput,
  InventoryFilters, InventoryRow, InventoryItemDetail,
  CargoExtraCharge, CargoExtraChargeInput, CreatePaymentInput,
} from '../types'
import { DEFAULT_SETTINGS } from '../types'
import { paymentErrorMessage, statusErrorMessage, extraChargeErrorMessage } from '../lib/domainErrors'
import {
  generateId, nextTrackingNumber, nextReceiptNumber,
  nextPackingListNumber, nowISO, todayDate,
} from '../lib/autoNumber'
import { supabase } from '../lib/supabase'

// ---------------------------------------------------------------------------
// Row <-> app-model mapping. Supabase/Postgres columns are snake_case; the
// app's types (and every screen) use camelCase, so this is the only layer
// that needs to know about the difference.
// ---------------------------------------------------------------------------

function mapCustomer(r: any): Customer {
  return {
    id: r.id, name: r.name, company: r.company, phone: r.phone, email: r.email,
    address: r.address, city: r.city, notes: r.notes ?? undefined,
    archivedAt: r.archived_at ?? undefined, archivedBy: r.archived_by ?? undefined, archivedReason: r.archived_reason ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function mapShipment(r: any): Shipment {
  const normalizedHistory: StatusEvent[] = (r.shipment_status_history ?? []).map((event: any) => ({
    status: event.new_status,
    previousStatus: event.previous_status ?? undefined,
    location: event.location ?? undefined,
    timestamp: event.changed_at,
    staff: event.changed_by_name ?? undefined,
    note: event.public_note ?? undefined,
    internalNote: event.internal_note ?? undefined,
    isPublic: Boolean(event.public_note),
    customsType: event.customs_type ?? undefined,
    customsLocation: event.customs_location ?? undefined,
    dispatchReference: event.dispatch_reference ?? undefined,
    isCorrection: Boolean(event.is_correction),
    correctionReason: event.correction_reason ?? undefined,
  }))
  return {
    id: r.id, trackingNumber: r.tracking_number, status: r.status,
    shipmentType: r.shipment_type, cargoCategory: r.cargo_category, serviceType: r.service_type,
    customerId: r.customer_id ?? '', origin: r.origin, destination: r.destination,
    destinationCity: r.destination_city, description: r.description,
    items: (r.shipment_items ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order).map((item: any) => ({
      id: item.id,
      itemNumber: item.item_number,
      itemCode: item.item_code ?? undefined,
      description: item.description,
      quantity: Number(item.quantity),
      unit: item.unit,
      sortOrder: item.sort_order,
      qrToken: item.qr_token ?? undefined,
      qrCreatedAt: item.qr_created_at ?? undefined,
    })),
    weightKg: Number(r.weight_kg), volumeCbm: Number(r.volume_cbm), pcs: r.pcs,
    shippingRate: r.shipping_rate, baseRate: Number(r.base_rate), otherCharges: Number(r.other_charges),
    discount: Number(r.discount), totalAmount: Number(r.total_amount), amountPaid: Number(r.amount_paid),
    currency: r.currency,
    customerNameSnapshot: r.customer_name_snapshot ?? undefined,
    customerPhoneSnapshot: r.customer_phone_snapshot ?? undefined,
    customerEmailSnapshot: r.customer_email_snapshot ?? undefined,
    pricingUnit: r.pricing_unit ?? undefined,
    standardRateUsd: r.standard_rate_usd == null ? undefined : Number(r.standard_rate_usd),
    appliedRateUsd: r.applied_rate_usd == null ? undefined : Number(r.applied_rate_usd),
    rateOverridden: Boolean(r.rate_overridden),
    overrideReason: r.override_reason ?? undefined,
    overriddenBy: r.overridden_by ?? undefined,
    overrideTimestamp: r.override_timestamp ?? undefined,
    baseCurrency: 'USD',
    baseAmountUsd: r.base_amount_usd == null ? undefined : Number(r.base_amount_usd),
    usdToTzsRateUsed: r.usd_to_tzs_rate_used == null ? undefined : Number(r.usd_to_tzs_rate_used),
    usdToAedRateUsed: r.usd_to_aed_rate_used == null ? undefined : Number(r.usd_to_aed_rate_used),
    selectedExchangeRate: r.selected_exchange_rate == null ? undefined : Number(r.selected_exchange_rate),
    exchangeRateDate: r.exchange_rate_date ?? undefined,
    invoiceCurrency: r.invoice_currency ?? undefined,
    invoiceAmount: r.invoice_amount == null ? undefined : Number(r.invoice_amount),
    invoiceNumber: r.invoice_number ?? undefined,
    invoiceFinalizedAt: r.invoice_finalized_at ?? undefined,
    packingListId: r.packing_list_id ?? undefined,
    isOnHold: Boolean(r.is_on_hold),
    holdReason: r.hold_reason ?? undefined,
    heldAt: r.held_at ?? undefined,
    customsType: r.customs_type ?? undefined,
    customsLocation: r.customs_location ?? undefined,
    customsStartedAt: r.customs_started_at ?? undefined,
    dispatchReference: r.dispatch_reference ?? undefined,
    dispatchedAt: r.dispatched_at ?? undefined,
    arrivedAt: r.arrived_at ?? undefined,
    deliveredAt: r.delivered_at ?? undefined,
    accountingJournalEntryId: r.accounting_journal_entry_id ?? undefined,
    voidedAt: r.voided_at ?? undefined,
    voidedBy: r.voided_by ?? undefined,
    voidedReason: r.voided_reason ?? undefined,
    notes: r.notes ?? undefined,
    statusHistory: normalizedHistory.length > 0 ? normalizedHistory : (r.status_history ?? []) as StatusEvent[],
    createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by,
  }
}

function mapPackingList(r: any): PackingList {
  return {
    id: r.id, listId: r.list_id, status: r.status, shipmentIds: r.shipment_ids ?? [],
    origin: r.origin, destination: r.destination, shipmentType: r.shipment_type,
    notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
    dispatchedAt: r.dispatched_at ?? undefined,
    closedAt: r.closed_at ?? undefined, closedBy: r.closed_by ?? undefined,
    createdBy: r.created_by,
  }
}

function mapPackingBox(r: any): PackingBox {
  return {
    id: r.id, packingListId: r.packing_list_id, boxNumber: r.box_number,
    createdBy: r.created_by ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function mapPackingAllocation(r: any): PackingAllocation {
  return {
    id: r.id, packingListId: r.packing_list_id, boxId: r.box_id,
    shipmentItemId: r.shipment_item_id, quantity: Number(r.quantity),
    createdBy: r.created_by ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function mapPayment(r: any): PaymentRecord {
  return {
    id: r.id, receiptNumber: r.receipt_number, shipmentId: r.shipment_id ?? undefined,
    shipmentIdSnapshot: r.shipment_id_snapshot ?? undefined,
    shipmentTrackingSnapshot: r.shipment_tracking_snapshot ?? undefined,
    amount: Number(r.amount), currency: r.currency, method: r.method, date: r.date,
    note: r.note ?? undefined, createdAt: r.created_at, createdBy: r.created_by,
    status: r.status ?? undefined,
    receivingAccountId: r.receiving_account_id ?? undefined,
    exchangeRate: r.exchange_rate == null ? undefined : Number(r.exchange_rate),
    reportingAmount: r.reporting_amount == null ? undefined : Number(r.reporting_amount),
    accountingJournalEntryId: r.accounting_journal_entry_id ?? undefined,
    idempotencyKey: r.idempotency_key ?? undefined,
  }
}

function mapCargoExtraCharge(r: any): CargoExtraCharge {
  return {
    id: r.id,
    shipmentId: r.shipment_id,
    chargeType: r.charge_type,
    customLabel: r.custom_label ?? undefined,
    direction: r.charge_direction,
    amount: Number(r.amount),
    currency: r.currency,
    chargeDate: r.charge_date,
    note: r.note ?? undefined,
    paymentMethod: r.payment_method ?? undefined,
    status: r.status,
    idempotencyKey: r.idempotency_key ?? undefined,
    exchangeRate: r.exchange_rate == null ? undefined : Number(r.exchange_rate),
    reportingAmount: r.reporting_amount == null ? undefined : Number(r.reporting_amount),
    accountingJournalEntryId: r.accounting_journal_entry_id ?? undefined,
    createdBy: r.created_by ?? undefined,
    createdAt: r.created_at,
    updatedBy: r.updated_by ?? undefined,
    updatedAt: r.updated_at,
    deletedBy: r.deleted_by ?? undefined,
    deletedAt: r.deleted_at ?? undefined,
  }
}

function mapPaymentRefund(r: any): PaymentRefund {
  return {
    id: r.id, paymentId: r.payment_id, refundAmount: Number(r.refund_amount), currency: r.currency,
    refundMethod: r.refund_method ?? undefined, refundDate: r.refund_date, reason: r.reason,
    processedBy: r.processed_by ?? undefined, processedByName: r.processed_by_name,
    accountingJournalEntryId: r.accounting_journal_entry_id ?? undefined, createdAt: r.created_at,
  }
}

function mapExpense(r: any): Expense {
  return {
    id: r.id, date: r.date, category: r.category, description: r.description,
    amount: Number(r.amount), currency: r.currency, reference: r.reference ?? undefined,
    shipmentId: r.shipment_id ?? undefined, notes: r.notes ?? undefined,
    createdAt: r.created_at, createdBy: r.created_by,
    expenseNumber: r.expense_number ?? undefined,
    payee: r.payee ?? undefined,
    paymentMethod: r.payment_method ?? undefined,
    expenseAccountId: r.expense_account_id ?? undefined,
    paymentAccountId: r.payment_account_id ?? undefined,
    exchangeRate: r.exchange_rate == null ? undefined : Number(r.exchange_rate),
    reportingAmount: r.reporting_amount == null ? undefined : Number(r.reporting_amount),
    status: r.status ?? undefined,
    accountingJournalEntryId: r.accounting_journal_entry_id ?? undefined,
    receiptStoragePath: r.receipt_storage_path ?? undefined,
  }
}

function mapSettings(r: any): CompanySettings {
  return {
    companyName: r.company_name, shortName: r.short_name ?? '', logoPath: r.logo_path ?? '',
    businessType: r.business_type, defaultCurrency: r.default_currency,
    exchangeRatePolicy: r.exchange_rate_policy ?? 'REQUIRE_TODAY',
    defaultItemStickerSize: r.default_item_sticker_size ?? '60x40',
    defaultOrigin: r.default_origin, defaultDestinationCountry: r.default_destination_country,
    supportedDestinationCities: r.supported_destination_cities ?? [],
    address: r.address, phone: r.phone, whatsapp: r.whatsapp ?? '', email: r.email, website: r.website,
    dubaiAddress: r.dubai_address ?? '', dubaiPhone: r.dubai_phone ?? '', dubaiEmail: r.dubai_email ?? '',
    tanzaniaAddress: r.tanzania_address ?? '', tanzaniaPhone: r.tanzania_phone ?? '', tanzaniaEmail: r.tanzania_email ?? '',
    taxId: r.tax_id, registrationNumber: r.registration_number ?? '',
    bankName: r.bank_name, bankAccount: r.bank_account, bankAccountName: r.bank_account_name ?? '', bankSwift: r.bank_swift,
    iban: r.iban ?? '', paymentInstructions: r.payment_instructions ?? '',
    invoiceFooter: r.invoice_footer ?? '', receiptFooter: r.receipt_footer ?? '',
    quoteFooter: r.quote_footer ?? '', packingListFooter: r.packing_list_footer ?? '',
    poweredByText: r.powered_by_text ?? '',
    trackingPrefix: r.tracking_prefix ?? '', packingListPrefix: r.packing_list_prefix ?? '',
    primaryColor: r.primary_color ?? '#0c1c35', secondaryColor: r.secondary_color ?? '#0a84d3', accentColor: r.accent_color ?? '#2f80ed',
    termsAndConditions: r.terms_and_conditions,
  }
}

function throwIfError<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

function unwrapRpcRow<T>(data: T | T[]): T {
  return Array.isArray(data) ? data[0] : data
}

const EXPENSE_ACCOUNT_CODES: Record<string, string> = {
  'Office Rent': '5000',
  'Staff Salaries': '5010',
  'Transport': '5020',
  'Fuel': '5030',
  'Packing Materials': '5040',
  'Airport Charges': '5050',
  'Port Charges': '5060',
  'Customs & Duties': '5070',
  'Utilities': '5080',
  'Internet / Phone': '5090',
  'Marketing': '5100',
  'Banking Fees': '5110',
  'Maintenance': '5190',
  'General Expenses': '5190',
  'Other': '5200',
}

// --- store interface -------------------------------------------------------
interface AppState {
  dataLoaded: boolean
  customers: Customer[]
  shipments: Shipment[]
  packingLists: PackingList[]
  packingBoxes: PackingBox[]
  packingAllocations: PackingAllocation[]
  payments: PaymentRecord[]
  extraCharges: CargoExtraCharge[]
  expenses: Expense[]
  settings: CompanySettings

  // Load everything from Supabase. Called once after login (see App.tsx) —
  // RLS means anonymous reads return nothing anyway, so there's no point
  // loading before authentication.
  loadAll: () => Promise<void>

  // Customer CRUD
  addCustomer: (data: Omit<Customer, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Customer>
  updateCustomer: (id: string, data: Partial<Customer>) => Promise<void>
  deleteCustomer: (id: string) => Promise<void>
  archiveCustomer: (id: string, reason?: string) => Promise<void>
  unarchiveCustomer: (id: string) => Promise<void>
  getCustomer: (id: string) => Customer | undefined

  // Shipment CRUD
  addShipment: (data: Omit<Shipment, 'id' | 'trackingNumber' | 'statusHistory' | 'createdAt' | 'updatedAt'>) => Promise<Shipment>
  updateShipment: (id: string, data: Partial<Shipment>) => Promise<void>
  deleteShipment: (id: string, reason: string) => Promise<void>
  getShipment: (id: string) => Shipment | undefined
  updateShipmentStatus: (id: string, input: StatusTransitionInput) => Promise<void>
  setShipmentHold: (id: string, onHold: boolean, reason: string) => Promise<void>
  voidShipment: (id: string, reason: string) => Promise<void>
  unvoidShipment: (id: string) => Promise<void>

  // Payment CRUD
  addPayment: (data: CreatePaymentInput) => Promise<PaymentRecord>
  deletePayment: (id: string) => Promise<void>
  refundPayment: (id: string, reason: string, refundMethod?: string) => Promise<PaymentRefund>
  getPaymentsForShipment: (shipmentId: string) => PaymentRecord[]

  // Cargo extra-charge CRUD (all writes go through audited RPCs)
  addCargoExtraCharge: (data: CargoExtraChargeInput) => Promise<CargoExtraCharge>
  updateCargoExtraCharge: (id: string, data: CargoExtraChargeInput, reason: string) => Promise<CargoExtraCharge>
  deleteCargoExtraCharge: (id: string, reason: string) => Promise<void>
  getExtraChargesForShipment: (shipmentId: string) => CargoExtraCharge[]

  // Packing List CRUD
  addPackingList: (data: Omit<PackingList, 'id' | 'listId' | 'createdAt' | 'updatedAt'>) => Promise<PackingList>
  updatePackingList: (id: string, data: Partial<PackingList>) => Promise<void>
  deletePackingList: (id: string) => Promise<void>
  dispatchPackingList: (id: string, dispatchedBy: string) => Promise<void>
  closePackingList: (id: string) => Promise<void>
  addShipmentToPackingList: (plId: string, shipmentId: string) => Promise<void>
  removeShipmentFromPackingList: (plId: string, shipmentId: string) => Promise<void>
  createPackingBox: (packingListId: string, boxNumber?: number) => Promise<PackingBox>
  upsertPackingAllocation: (boxId: string, shipmentItemId: string, quantity: number, operation?: 'ADD' | 'SET') => Promise<PackingAllocation>
  removePackingAllocation: (allocationId: string) => Promise<void>
  movePackingAllocation: (allocationId: string, toBoxId: string, quantity: number) => Promise<void>

  // Storage / Inventory — deliberately NOT cached in this store. The
  // underlying shipment_items table can be large and every quantity is
  // computed server-side (see search_inventory()/get_inventory_item_detail()
  // in supabase/migrations/20260817184710_storage_inventory.sql), so the
  // Storage screen owns its own local search/filter/pagination state and
  // just calls these on demand rather than the browser holding a second,
  // possibly-stale copy of the whole inventory.
  searchInventory: (filters: InventoryFilters, limit: number, offset: number) => Promise<{ rows: InventoryRow[]; totalCount: number }>
  recordItemReturn: (shipmentItemId: string, quantity: number, reason?: string) => Promise<void>
  getInventoryItemDetail: (shipmentItemId: string) => Promise<InventoryItemDetail>

  // Expense CRUD
  addExpense: (data: Omit<Expense, 'id' | 'createdAt'>) => Promise<Expense>
  updateExpense: (id: string, data: Partial<Expense>) => Promise<void>
  deleteExpense: (id: string) => Promise<void>

  // Settings
  updateSettings: (data: Partial<CompanySettings>) => Promise<void>
}

export const useAppStore = create<AppState>()((set, get) => ({
  dataLoaded: false,
  customers: [],
  shipments: [],
  packingLists: [],
  packingBoxes: [],
  packingAllocations: [],
  payments: [],
  extraCharges: [],
  expenses: [],
  settings: DEFAULT_SETTINGS,

  loadAll: async () => {
    const [customers, shipments, packingLists, packingBoxes, packingAllocations, payments, extraCharges, expenses, settingsRes] = await Promise.all([
      supabase.from('customers').select('*').order('created_at', { ascending: false }),
      supabase.from('shipments').select('*, shipment_items(*), shipment_status_history(*)').order('created_at', { ascending: false }),
      supabase.from('packing_lists').select('*').order('created_at', { ascending: false }),
      supabase.from('packing_boxes').select('*').order('box_number'),
      supabase.from('packing_list_items').select('*').order('created_at'),
      supabase.from('payment_records').select('*').order('created_at', { ascending: false }),
      supabase.from('cargo_extra_charges').select('*').eq('status', 'ACTIVE').order('created_at', { ascending: false }),
      supabase.from('expenses').select('*').order('created_at', { ascending: false }),
      supabase.from('company_settings').select('*').eq('id', 'default').maybeSingle(),
    ])
    // expenses may legitimately come back empty for a role RLS excludes
    // (Operations Staff) rather than erroring — that's not a failure, so
    // only genuine query errors are reported here.
    const failedLoads: string[] = []
    if (customers.error) { console.error('[useAppStore] load customers failed:', customers.error.message); failedLoads.push('customers') }
    if (shipments.error) { console.error('[useAppStore] load shipments failed:', shipments.error.message); failedLoads.push('shipments') }
    if (packingLists.error) { console.error('[useAppStore] load packingLists failed:', packingLists.error.message); failedLoads.push('packing lists') }
    if (packingBoxes.error) { console.error('[useAppStore] load packingBoxes failed:', packingBoxes.error.message); failedLoads.push('packing boxes') }
    if (packingAllocations.error) { console.error('[useAppStore] load packingAllocations failed:', packingAllocations.error.message); failedLoads.push('packing allocations') }
    if (payments.error) { console.error('[useAppStore] load payments failed:', payments.error.message); failedLoads.push('payments') }
    if (extraCharges.error) { console.error('[useAppStore] load cargo extra charges failed:', extraCharges.error.message); failedLoads.push('cargo charges') }
    if (expenses.error) { console.error('[useAppStore] load expenses failed:', expenses.error.message); failedLoads.push('expenses') }
    if (failedLoads.length > 0) {
      toast.error(
        `Some data couldn't be loaded (${failedLoads.join(', ')}). Check your connection and try refreshing — contact an admin if this continues.`,
        { duration: 6000 }
      )
    }

    // The migration seeds the one company row. A non-Admin browser must never
    // create it, otherwise ordinary staff could race the first setup.
    let settings = DEFAULT_SETTINGS
    if (settingsRes.data) {
      settings = mapSettings(settingsRes.data)
    }

    set({
      dataLoaded: true,
      customers: (customers.data ?? []).map(mapCustomer),
      shipments: (shipments.data ?? []).map(mapShipment),
      packingLists: (packingLists.data ?? []).map(mapPackingList),
      packingBoxes: (packingBoxes.data ?? []).map(mapPackingBox),
      packingAllocations: (packingAllocations.data ?? []).map(mapPackingAllocation),
      payments: (payments.data ?? []).map(mapPayment),
      extraCharges: (extraCharges.data ?? []).map(mapCargoExtraCharge),
      expenses: (expenses.data ?? []).map(mapExpense),
      settings,
    })
  },

  // --- Customers ---
  addCustomer: async (data) => {
    const row = {
      id: generateId(), name: data.name, company: data.company, phone: data.phone,
      email: data.email, address: data.address, city: data.city, notes: data.notes ?? null,
      created_at: todayDate(), updated_at: todayDate(),
    }
    const inserted = throwIfError(await supabase.from('customers').insert(row).select().single())
    const customer = mapCustomer(inserted)
    set(s => ({ customers: [customer, ...s.customers] }))
    return customer
  },
  updateCustomer: async (id, data) => {
    const patch: Record<string, unknown> = { updated_at: todayDate() }
    if (data.name !== undefined) patch.name = data.name
    if (data.company !== undefined) patch.company = data.company
    if (data.phone !== undefined) patch.phone = data.phone
    if (data.email !== undefined) patch.email = data.email
    if (data.address !== undefined) patch.address = data.address
    if (data.city !== undefined) patch.city = data.city
    if (data.notes !== undefined) patch.notes = data.notes
    throwIfError(await supabase.from('customers').update(patch).eq('id', id).select().single())
    set(s => ({
      customers: s.customers.map(c => c.id === id ? { ...c, ...data, updatedAt: todayDate() } : c),
    }))
  },
  deleteCustomer: async (id) => {
    throwIfError(await supabase.from('customers').delete().eq('id', id).select())
    set(s => ({ customers: s.customers.filter(c => c.id !== id) }))
  },
  archiveCustomer: async (id, reason) => {
    // Guarded RPC only — see archive_customer() in
    // supabase/migrations/20260817193000_controlled_deletion_archive.sql.
    // Admin-only server-side; the frontend gate is a UX convenience, not
    // the real enforcement.
    const row = throwIfError(await supabase.rpc('archive_customer', { p_customer_id: id, p_reason: reason ?? null }))
    const updated = mapCustomer(unwrapRpcRow(row))
    set(s => ({ customers: s.customers.map(c => c.id === id ? updated : c) }))
  },
  unarchiveCustomer: async (id) => {
    const row = throwIfError(await supabase.rpc('unarchive_customer', { p_customer_id: id }))
    const updated = mapCustomer(unwrapRpcRow(row))
    set(s => ({ customers: s.customers.map(c => c.id === id ? updated : c) }))
  },
  getCustomer: (id) => get().customers.find(c => c.id === id),

  // --- Shipments ---
  addShipment: async (data) => {
    const trackingNumber = nextTrackingNumber(
      get().shipments.map(s => s.trackingNumber),
      get().settings.trackingPrefix,
    )
    const statusHistory: StatusEvent[] = [{
      status: data.status,
      location: data.origin,
      timestamp: nowISO(),
      staff: data.createdBy,
      note: 'Shipment created.',
      isPublic: true,
    }]
    const row = {
      id: generateId(), tracking_number: trackingNumber, status: data.status,
      shipment_type: data.shipmentType, cargo_category: data.cargoCategory, service_type: data.serviceType,
      customer_id: data.customerId || null, origin: data.origin, destination: data.destination,
      destination_city: data.destinationCity, description: data.description,
      weight_kg: data.weightKg, volume_cbm: data.volumeCbm, pcs: data.pcs,
      shipping_rate: data.shippingRate, base_rate: data.baseRate, other_charges: data.otherCharges,
      discount: data.discount, total_amount: data.totalAmount, amount_paid: data.amountPaid,
      currency: data.currency,
      customer_name_snapshot: data.customerNameSnapshot ?? null,
      customer_phone_snapshot: data.customerPhoneSnapshot ?? null,
      customer_email_snapshot: data.customerEmailSnapshot ?? null,
      pricing_unit: data.pricingUnit ?? null,
      standard_rate_usd: data.standardRateUsd ?? null,
      applied_rate_usd: data.appliedRateUsd ?? null,
      rate_overridden: data.rateOverridden,
      override_reason: data.overrideReason ?? null,
      overridden_by: data.overriddenBy ?? null,
      override_timestamp: data.overrideTimestamp ?? null,
      base_currency: data.baseCurrency,
      base_amount_usd: data.baseAmountUsd ?? null,
      usd_to_tzs_rate_used: data.usdToTzsRateUsed ?? null,
      usd_to_aed_rate_used: data.usdToAedRateUsed ?? null,
      selected_exchange_rate: data.selectedExchangeRate ?? null,
      exchange_rate_date: data.exchangeRateDate ?? null,
      invoice_currency: data.invoiceCurrency ?? null,
      invoice_amount: data.invoiceAmount ?? null,
      invoice_number: data.invoiceNumber ?? null,
      invoice_finalized_at: null,
      packing_list_id: data.packingListId || null,
      is_on_hold: data.isOnHold ?? false,
      notes: data.notes ?? null,
      status_history: statusHistory, created_by: data.createdBy,
      created_at: todayDate(), updated_at: todayDate(),
    }
    const inserted = throwIfError(await supabase.from('shipments').insert(row).select().single())
    if (data.items.length > 0) {
      const itemRows = data.items.map(item => ({
        shipment_id: inserted.id,
        item_number: item.itemNumber,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        sort_order: item.sortOrder,
      }))
      const itemResult = await supabase.from('shipment_items').insert(itemRows).select()
      if (itemResult.error) {
        await supabase.from('shipments').delete().eq('id', inserted.id)
        throw new Error(`Cargo items could not be saved: ${itemResult.error.message}`)
      }
      inserted.shipment_items = itemResult.data
    }
    if (data.invoiceFinalizedAt) {
      const finalized = await supabase.from('shipments')
        .update({ invoice_finalized_at: data.invoiceFinalizedAt })
        .eq('id', inserted.id)
        .select()
        .single()
      if (finalized.error) {
        await supabase.from('shipments').delete().eq('id', inserted.id)
        throw new Error(`Invoice could not be finalized: ${finalized.error.message}`)
      }
      Object.assign(inserted, finalized.data, { shipment_items: inserted.shipment_items })
      const posting = await supabase.rpc('post_invoice_accounting', { p_shipment_id: inserted.id })
      if (posting.error) {
        throw new Error(`Invoice was finalized but accounting posting failed: ${posting.error.message}`)
      }
      const refreshed = await supabase.from('shipments')
        .select('*, shipment_items(*), shipment_status_history(*)')
        .eq('id', inserted.id).single()
      if (!refreshed.error) Object.assign(inserted, refreshed.data)
    }
    const shipment = mapShipment(inserted)
    set(s => ({ shipments: [shipment, ...s.shipments] }))
    return shipment
  },
  updateShipment: async (id, data) => {
    const patch: Record<string, unknown> = { updated_at: todayDate() }
    if (data.shipmentType !== undefined) patch.shipment_type = data.shipmentType
    if (data.cargoCategory !== undefined) patch.cargo_category = data.cargoCategory
    if (data.serviceType !== undefined) patch.service_type = data.serviceType
    if (data.customerId !== undefined) patch.customer_id = data.customerId || null
    if (data.origin !== undefined) patch.origin = data.origin
    if (data.destination !== undefined) patch.destination = data.destination
    if (data.destinationCity !== undefined) patch.destination_city = data.destinationCity
    if (data.description !== undefined) patch.description = data.description
    if (data.weightKg !== undefined) patch.weight_kg = data.weightKg
    if (data.volumeCbm !== undefined) patch.volume_cbm = data.volumeCbm
    if (data.pcs !== undefined) patch.pcs = data.pcs
    if (data.shippingRate !== undefined) patch.shipping_rate = data.shippingRate
    if (data.baseRate !== undefined) patch.base_rate = data.baseRate
    if (data.otherCharges !== undefined) patch.other_charges = data.otherCharges
    if (data.discount !== undefined) patch.discount = data.discount
    if (data.totalAmount !== undefined) patch.total_amount = data.totalAmount
    if (data.amountPaid !== undefined) patch.amount_paid = data.amountPaid
    if (data.currency !== undefined) patch.currency = data.currency
    if (data.packingListId !== undefined) patch.packing_list_id = data.packingListId || null
    if (data.notes !== undefined) patch.notes = data.notes
    throwIfError(await supabase.from('shipments').update(patch).eq('id', id).select().single())
    set(s => ({
      shipments: s.shipments.map(sh => sh.id === id ? { ...sh, ...data, updatedAt: todayDate() } : sh),
    }))
  },
  deleteShipment: async (id, reason) => {
    // Guarded RPC only — see delete_shipment() in
    // supabase/migrations/20260819120000_shipment_delete_and_payment_refund.sql.
    // Admin-only server-side; blocked once the shipment has packing/return/
    // delivery history (void it instead). Any payment_records rows on it are
    // detached (shipment_id -> null, snapshot kept), never cascade-deleted.
    throwIfError(await supabase.rpc('delete_shipment', { p_shipment_id: id, p_reason: reason }))
    set(s => ({
      shipments: s.shipments.filter(sh => sh.id !== id),
      payments: s.payments.map(p => p.shipmentId === id
        ? { ...p, shipmentId: undefined, shipmentIdSnapshot: id, shipmentTrackingSnapshot: s.shipments.find(sh => sh.id === id)?.trackingNumber }
        : p),
    }))
  },
  getShipment: (id) => get().shipments.find(s => s.id === id),
  updateShipmentStatus: async (id, input) => {
    const shipment = get().shipments.find(s => s.id === id)
    if (!shipment) throw new Error('This shipment is no longer available. Refresh the page before updating its status.')
    try {
      const response = await supabase.rpc('transition_shipment_status_confirmed', {
        p_shipment_id: id,
        p_new_status: input.status,
        p_location: input.location ?? null,
        p_public_note: input.publicNote ?? null,
        p_internal_note: input.internalNote ?? null,
        p_customs_type: input.customsType ?? null,
        p_customs_location: input.customsLocation ?? null,
        p_dispatch_reference: input.dispatchReference ?? null,
        p_correction_reason: input.correctionReason ?? null,
        p_recipient_name: input.delivery?.recipientName ?? null,
        p_recipient_phone: input.delivery?.recipientPhone ?? null,
        p_delivered_at: input.delivery?.deliveredAt ?? null,
        p_delivery_notes: input.delivery?.notes ?? null,
        p_proof_storage_path: input.delivery?.proofStoragePath ?? null,
      })
      if (response.error) throw response.error
      const result: any = unwrapRpcRow(response.data)
      const shipmentRow = result?.shipment
      const historyRow = result?.history
      if (!shipmentRow || shipmentRow.id !== id || shipmentRow.status !== input.status || !historyRow) {
        throw new Error('Shipment status confirmation failed because the stored status did not match.')
      }
      const newEvent: StatusEvent = {
        status: historyRow.new_status,
        previousStatus: historyRow.previous_status ?? undefined,
        location: historyRow.location ?? undefined,
        timestamp: historyRow.changed_at,
        staff: historyRow.changed_by_name,
        note: historyRow.public_note ?? undefined,
        internalNote: historyRow.internal_note ?? undefined,
        isPublic: Boolean(historyRow.public_note),
        customsType: historyRow.customs_type ?? undefined,
        customsLocation: historyRow.customs_location ?? undefined,
        dispatchReference: historyRow.dispatch_reference ?? undefined,
        isCorrection: Boolean(historyRow.is_correction),
        correctionReason: historyRow.correction_reason ?? undefined,
      }
      set(s => ({
        shipments: s.shipments.map(sh => sh.id === id ? {
          ...sh,
          status: shipmentRow.status,
          statusHistory: [...sh.statusHistory, newEvent],
          customsType: shipmentRow.customs_type ?? undefined,
          customsLocation: shipmentRow.customs_location ?? undefined,
          dispatchReference: shipmentRow.dispatch_reference ?? undefined,
          dispatchedAt: shipmentRow.dispatched_at ?? undefined,
          arrivedAt: shipmentRow.arrived_at ?? undefined,
          deliveredAt: shipmentRow.delivered_at ?? undefined,
          updatedAt: shipmentRow.updated_at,
        } : sh),
      }))
    } catch (error) {
      console.error('[useAppStore] shipment status update failed:', error)
      throw new Error(statusErrorMessage(error))
    }
  },
  setShipmentHold: async (id, onHold, reason) => {
    const row = throwIfError(await supabase.rpc('set_shipment_hold', {
      p_shipment_id: id,
      p_on_hold: onHold,
      p_reason: reason,
    }))
    const updated: any = unwrapRpcRow(row)
    set(s => ({
      shipments: s.shipments.map(sh => sh.id === id ? {
        ...sh,
        isOnHold: Boolean(updated.is_on_hold),
        holdReason: updated.hold_reason ?? undefined,
        heldAt: updated.held_at ?? undefined,
        updatedAt: updated.updated_at,
      } : sh),
    }))
  },

  voidShipment: async (id, reason) => {
    // Guarded RPC only — see void_shipment() in
    // supabase/migrations/20260817193000_controlled_deletion_archive.sql.
    // Admin-only server-side; never touches shipment status, only marks it
    // voided (same "flag layered on top of the real status" shape as hold).
    const row = throwIfError(await supabase.rpc('void_shipment', { p_shipment_id: id, p_reason: reason }))
    const updated: any = unwrapRpcRow(row)
    set(s => ({
      shipments: s.shipments.map(sh => sh.id === id ? {
        ...sh,
        voidedAt: updated.voided_at ?? undefined,
        voidedBy: updated.voided_by ?? undefined,
        voidedReason: updated.voided_reason ?? undefined,
      } : sh),
    }))
  },

  unvoidShipment: async (id) => {
    const row = throwIfError(await supabase.rpc('unvoid_shipment', { p_shipment_id: id }))
    const updated: any = unwrapRpcRow(row)
    set(s => ({
      shipments: s.shipments.map(sh => sh.id === id ? {
        ...sh,
        voidedAt: updated.voided_at ?? undefined,
        voidedBy: updated.voided_by ?? undefined,
        voidedReason: updated.voided_reason ?? undefined,
      } : sh),
    }))
  },

  // --- Payments ---
  addPayment: async (data) => {
    const targetShipment = get().shipments.find(s => s.id === data.shipmentId)
    if (!targetShipment) throw new Error('This shipment is no longer available. Refresh the page and select it again.')
    const invoiceCurrency = targetShipment?.invoiceCurrency ?? targetShipment?.currency
    if (invoiceCurrency && data.currency !== invoiceCurrency) {
      throw new Error(`Payment currency must match the invoice currency (${invoiceCurrency}).`)
    }
    try {
      const response = await supabase.rpc('record_payment', {
        p_shipment_id: data.shipmentId,
        p_amount: data.amount,
        p_currency: data.currency,
        p_method: data.method,
        p_payment_date: data.date,
        p_note: data.note ?? null,
        p_idempotency_key: data.idempotencyKey,
        p_receiving_account_code: data.method === 'Cash' ? '1000' : '1010',
      })
      if (response.error) throw response.error
      const result: any = unwrapRpcRow(response.data)
      if (!result?.payment?.id || result.payment.shipment_id !== data.shipmentId) {
        throw new Error('Payment confirmation failed because the saved row was not returned.')
      }
      const payment = mapPayment(result.payment)
      const amountPaid = Number(result.shipmentAmountPaid)
      set(s => ({
        payments: [payment, ...s.payments.filter(existing => existing.id !== payment.id)],
        shipments: s.shipments.map(sh =>
          sh.id === data.shipmentId ? { ...sh, amountPaid, updatedAt: result.shipmentUpdatedAt ?? sh.updatedAt } : sh
        ),
      }))
      return payment
    } catch (error) {
      console.error('[useAppStore] record payment failed:', error)
      throw new Error(paymentErrorMessage(error))
    }
  },
  deletePayment: async (id) => {
    const payment = get().payments.find(p => p.id === id)
    if (!payment) return
    if (payment.status === 'POSTED' || payment.accountingJournalEntryId) {
      throw new Error('Posted payments cannot be deleted. Use an authorized reversal workflow.')
    }
    throwIfError(await supabase.from('payment_records').delete().eq('id', id).select())
    if (payment.shipmentId) {
      const authoritative = throwIfError(await supabase.from('shipments')
        .select('amount_paid, updated_at')
        .eq('id', payment.shipmentId).single())
      if (!authoritative) throw new Error('Payment deletion could not be confirmed from the shipment record.')
      set(s => ({
        payments: s.payments.filter(p => p.id !== id),
        shipments: s.shipments.map(sh => sh.id === payment.shipmentId ? {
          ...sh,
          amountPaid: Number(authoritative.amount_paid),
          updatedAt: authoritative.updated_at,
        } : sh),
      }))
    } else {
      set(s => ({ payments: s.payments.filter(p => p.id !== id) }))
    }
  },
  refundPayment: async (id, reason, refundMethod) => {
    // Guarded RPC only — see refund_payment() in
    // supabase/migrations/20260819120000_shipment_delete_and_payment_refund.sql.
    // Admin-only server-side; reverses the payment's posted journal entry
    // (mirror-image entry, same mechanics as void_accounting_entry()) and
    // relabels the payment REFUNDED — the original row is never deleted.
    const row = throwIfError(await supabase.rpc('refund_payment', {
      p_payment_id: id, p_reason: reason, p_refund_method: refundMethod ?? null,
    }))
    const refund = mapPaymentRefund(unwrapRpcRow(row))
    const payment = get().payments.find(p => p.id === id)
    let authoritativeAmountPaid: number | undefined
    let authoritativeUpdatedAt: string | undefined
    if (payment?.shipmentId) {
      const authoritative = throwIfError(await supabase.from('shipments')
        .select('amount_paid, updated_at')
        .eq('id', payment.shipmentId).single())
      if (!authoritative) throw new Error('Payment refund could not be confirmed from the shipment record.')
      authoritativeAmountPaid = Number(authoritative.amount_paid)
      authoritativeUpdatedAt = authoritative.updated_at
    }
    set(s => ({
      payments: s.payments.map(p => p.id === id ? { ...p, status: 'REFUNDED' } : p),
      shipments: payment?.shipmentId
        ? s.shipments.map(sh => sh.id === payment.shipmentId
          ? { ...sh, amountPaid: authoritativeAmountPaid ?? sh.amountPaid, updatedAt: authoritativeUpdatedAt ?? sh.updatedAt }
          : sh)
        : s.shipments,
    }))
    return refund
  },
  getPaymentsForShipment: (shipmentId) => get().payments.filter(p => p.shipmentId === shipmentId),

  addCargoExtraCharge: async (data) => {
    try {
      const response = await supabase.rpc('create_cargo_extra_charge', {
        p_shipment_id: data.shipmentId,
        p_charge_type: data.chargeType,
        p_custom_label: data.customLabel ?? null,
        p_charge_direction: data.direction,
        p_amount: data.amount,
        p_currency: data.currency,
        p_charge_date: data.chargeDate,
        p_note: data.note ?? null,
        p_payment_method: data.paymentMethod ?? null,
        p_idempotency_key: data.idempotencyKey,
      })
      if (response.error) throw response.error
      const charge = mapCargoExtraCharge(unwrapRpcRow(response.data))
      if (!charge.id || charge.shipmentId !== data.shipmentId) throw new Error('Cargo charge confirmation failed.')
      set(s => ({ extraCharges: [charge, ...s.extraCharges.filter(existing => existing.id !== charge.id)] }))
      return charge
    } catch (error) {
      console.error('[useAppStore] create cargo extra charge failed:', error)
      throw new Error(extraChargeErrorMessage(error))
    }
  },

  updateCargoExtraCharge: async (id, data, reason) => {
    try {
      const response = await supabase.rpc('update_cargo_extra_charge', {
        p_charge_id: id,
        p_charge_type: data.chargeType,
        p_custom_label: data.customLabel ?? null,
        p_charge_direction: data.direction,
        p_amount: data.amount,
        p_currency: data.currency,
        p_charge_date: data.chargeDate,
        p_note: data.note ?? null,
        p_payment_method: data.paymentMethod ?? null,
        p_reason: reason,
      })
      if (response.error) throw response.error
      const charge = mapCargoExtraCharge(unwrapRpcRow(response.data))
      if (!charge.id || charge.id !== id) throw new Error('Cargo charge confirmation failed.')
      set(s => ({ extraCharges: s.extraCharges.map(existing => existing.id === id ? charge : existing) }))
      return charge
    } catch (error) {
      console.error('[useAppStore] update cargo extra charge failed:', error)
      throw new Error(extraChargeErrorMessage(error))
    }
  },

  deleteCargoExtraCharge: async (id, reason) => {
    try {
      const response = await supabase.rpc('delete_cargo_extra_charge', { p_charge_id: id, p_reason: reason })
      if (response.error) throw response.error
      const charge = mapCargoExtraCharge(unwrapRpcRow(response.data))
      if (!charge.id || charge.id !== id || charge.status !== 'DELETED') throw new Error('Cargo charge deletion was not confirmed.')
      set(s => ({ extraCharges: s.extraCharges.filter(existing => existing.id !== id) }))
    } catch (error) {
      console.error('[useAppStore] delete cargo extra charge failed:', error)
      throw new Error(extraChargeErrorMessage(error))
    }
  },

  getExtraChargesForShipment: (shipmentId) => get().extraCharges.filter(charge => charge.shipmentId === shipmentId && charge.status === 'ACTIVE'),

  // --- Packing Lists ---
  addPackingList: async (data) => {
    const listId = nextPackingListNumber(
      get().packingLists.map(p => p.listId),
      get().settings.packingListPrefix,
    )
    const row = {
      id: generateId(), list_id: listId, status: data.status, shipment_ids: data.shipmentIds,
      origin: data.origin, destination: data.destination, shipment_type: data.shipmentType,
      notes: data.notes ?? null, created_at: todayDate(), updated_at: todayDate(),
      dispatched_at: data.dispatchedAt ?? null, created_by: data.createdBy,
    }
    const inserted = throwIfError(await supabase.from('packing_lists').insert(row).select().single())
    const pl = mapPackingList(inserted)
    let boxRow: any
    try {
      boxRow = throwIfError(await supabase.rpc('create_packing_box', {
        p_packing_list_id: pl.id,
        p_box_number: 1,
      }))
    } catch (error) {
      await supabase.from('packing_lists').delete().eq('id', pl.id)
      throw error
    }
    const firstBox = mapPackingBox(unwrapRpcRow(boxRow))
    set(s => ({ packingLists: [pl, ...s.packingLists], packingBoxes: [...s.packingBoxes, firstBox] }))
    return pl
  },
  updatePackingList: async (id, data) => {
    const patch: Record<string, unknown> = { updated_at: todayDate() }
    if (data.status !== undefined) patch.status = data.status
    if (data.shipmentIds !== undefined) patch.shipment_ids = data.shipmentIds
    if (data.origin !== undefined) patch.origin = data.origin
    if (data.destination !== undefined) patch.destination = data.destination
    if (data.shipmentType !== undefined) patch.shipment_type = data.shipmentType
    if (data.notes !== undefined) patch.notes = data.notes
    if (data.dispatchedAt !== undefined) patch.dispatched_at = data.dispatchedAt
    throwIfError(await supabase.from('packing_lists').update(patch).eq('id', id).select().single())
    set(s => ({
      packingLists: s.packingLists.map(pl => pl.id === id ? { ...pl, ...data, updatedAt: todayDate() } : pl),
    }))
  },
  deletePackingList: async (id) => {
    const pl = get().packingLists.find(p => p.id === id)
    if (!pl) return
    throwIfError(await supabase.from('packing_lists').delete().eq('id', id).select())
    // Clear packing_list_id off any shipments that referenced it (the FK is
    // ON DELETE SET NULL, so the DB already did this — mirror it locally).
    set(s => ({
      packingLists: s.packingLists.filter(p => p.id !== id),
      packingBoxes: s.packingBoxes.filter(box => box.packingListId !== id),
      packingAllocations: s.packingAllocations.filter(allocation => allocation.packingListId !== id),
      shipments: s.shipments.map(sh =>
        pl.shipmentIds.includes(sh.id) ? { ...sh, packingListId: undefined } : sh
      ),
    }))
  },
  dispatchPackingList: async (id, dispatchedBy) => {
    const pl = get().packingLists.find(p => p.id === id)
    if (!pl) return
    throwIfError(await supabase.rpc('dispatch_packing_list_with_status', {
      p_packing_list_id: id,
      p_dispatch_note: `Dispatched via packing list ${pl.listId}`,
    }))
    await get().loadAll()
  },
  closePackingList: async (id) => {
    // Guarded RPC only — see close_packing_list() in
    // supabase/migrations/20260817182455_close_packing_list.sql. It never
    // touches shipments; only status/closed_at/closed_by on this list.
    throwIfError(await supabase.rpc('close_packing_list', { p_packing_list_id: id }))
    await get().loadAll()
  },
  addShipmentToPackingList: async (plId, shipmentId) => {
    const pl = get().packingLists.find(p => p.id === plId)
    if (!pl || pl.shipmentIds.includes(shipmentId)) return
    const shipmentIds = [...pl.shipmentIds, shipmentId]
    await Promise.all([
      supabase.from('packing_lists').update({ shipment_ids: shipmentIds, updated_at: todayDate() }).eq('id', plId).select().single().then(throwIfError),
      supabase.from('shipments').update({ packing_list_id: plId }).eq('id', shipmentId).select().single().then(throwIfError),
    ])
    set(s => ({
      packingLists: s.packingLists.map(p => p.id === plId ? { ...p, shipmentIds, updatedAt: todayDate() } : p),
      shipments: s.shipments.map(sh => sh.id === shipmentId ? { ...sh, packingListId: plId } : sh),
    }))
  },
  removeShipmentFromPackingList: async (plId, shipmentId) => {
    const pl = get().packingLists.find(p => p.id === plId)
    if (!pl) return
    const shipmentIds = pl.shipmentIds.filter(id => id !== shipmentId)
    await Promise.all([
      supabase.from('packing_lists').update({ shipment_ids: shipmentIds, updated_at: todayDate() }).eq('id', plId).select().single().then(throwIfError),
      supabase.from('shipments').update({ packing_list_id: null }).eq('id', shipmentId).select().single().then(throwIfError),
    ])
    set(s => ({
      packingLists: s.packingLists.map(p => p.id === plId ? { ...p, shipmentIds, updatedAt: todayDate() } : p),
      shipments: s.shipments.map(sh => sh.id === shipmentId ? { ...sh, packingListId: undefined } : sh),
    }))
  },

  createPackingBox: async (packingListId, boxNumber) => {
    const row = throwIfError(await supabase.rpc('create_packing_box', {
      p_packing_list_id: packingListId,
      p_box_number: boxNumber ?? null,
    }))
    const box = mapPackingBox(unwrapRpcRow(row))
    set(s => ({ packingBoxes: [...s.packingBoxes, box].sort((a, b) => a.boxNumber - b.boxNumber) }))
    return box
  },

  upsertPackingAllocation: async (boxId, shipmentItemId, quantity, operation = 'ADD') => {
    const row = throwIfError(await supabase.rpc('upsert_packing_allocation', {
      p_box_id: boxId,
      p_shipment_item_id: shipmentItemId,
      p_quantity: quantity,
      p_operation: operation,
    }))
    const allocation = mapPackingAllocation(unwrapRpcRow(row))
    const shipment = get().shipments.find(candidate => candidate.items.some(item => item.id === shipmentItemId))
    set(s => ({
      packingAllocations: s.packingAllocations.some(existing => existing.id === allocation.id)
        ? s.packingAllocations.map(existing => existing.id === allocation.id ? allocation : existing)
        : [...s.packingAllocations, allocation],
      packingLists: shipment ? s.packingLists.map(list => list.id === allocation.packingListId && !list.shipmentIds.includes(shipment.id)
        ? { ...list, shipmentIds: [...list.shipmentIds, shipment.id] }
        : list) : s.packingLists,
      shipments: shipment ? s.shipments.map(candidate => candidate.id === shipment.id
        ? { ...candidate, packingListId: candidate.packingListId || allocation.packingListId }
        : candidate) : s.shipments,
    }))
    return allocation
  },

  removePackingAllocation: async (allocationId) => {
    const existing = get().packingAllocations.find(allocation => allocation.id === allocationId)
    if (!existing) return
    throwIfError(await supabase.rpc('remove_packing_allocation', { p_allocation_id: allocationId }))
    const shipment = get().shipments.find(candidate => candidate.items.some(item => item.id === existing.shipmentItemId))
    const remaining = get().packingAllocations.filter(allocation => allocation.id !== allocationId)
    const shipmentStillPresent = shipment ? remaining.some(allocation => {
      if (allocation.packingListId !== existing.packingListId) return false
      return shipment.items.some(item => item.id === allocation.shipmentItemId)
    }) : false
    set(s => ({
      packingAllocations: remaining,
      packingLists: shipment && !shipmentStillPresent ? s.packingLists.map(list => list.id === existing.packingListId
        ? { ...list, shipmentIds: list.shipmentIds.filter(id => id !== shipment.id) }
        : list) : s.packingLists,
      shipments: shipment && !shipmentStillPresent ? s.shipments.map(candidate => candidate.id === shipment.id && candidate.packingListId === existing.packingListId
        ? { ...candidate, packingListId: undefined }
        : candidate) : s.shipments,
    }))
  },

  movePackingAllocation: async (allocationId, toBoxId, quantity) => {
    throwIfError(await supabase.rpc('move_packing_allocation', {
      p_allocation_id: allocationId,
      p_to_box_id: toBoxId,
      p_quantity: quantity,
    }))
    await get().loadAll()
  },

  // --- Storage / Inventory ---
  searchInventory: async (filters, limit, offset) => {
    const rows = throwIfError(await supabase.rpc('search_inventory', {
      p_search: filters.search?.trim() || null,
      p_customer_id: filters.customerId || null,
      p_tracking_number: filters.trackingNumber?.trim() || null,
      p_packing_status: filters.packingStatus || null,
      p_returned_only: filters.returnedOnly ?? false,
      p_limit: limit,
      p_offset: offset,
    })) as any[]
    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0
    return {
      rows: rows.map((r): InventoryRow => ({
        shipmentItemId: r.shipment_item_id,
        itemCode: r.item_code ?? undefined,
        description: r.description,
        unit: r.unit,
        totalQuantity: Number(r.total_quantity),
        packedQuantity: Number(r.packed_quantity),
        dispatchedQuantity: Number(r.dispatched_quantity),
        returnedQuantity: Number(r.returned_quantity),
        storageQuantity: Number(r.storage_quantity),
        shipmentId: r.shipment_id,
        trackingNumber: r.tracking_number,
        shipmentStatus: r.shipment_status,
        customerId: r.customer_id ?? undefined,
        customerName: r.customer_name,
        lastUpdated: r.last_updated ?? undefined,
      })),
      totalCount,
    }
  },

  recordItemReturn: async (shipmentItemId, quantity, reason) => {
    throwIfError(await supabase.rpc('record_item_return', {
      p_shipment_item_id: shipmentItemId,
      p_quantity: quantity,
      p_reason: reason?.trim() || null,
    }))
  },

  getInventoryItemDetail: async (shipmentItemId) => {
    const detail = throwIfError(await supabase.rpc('get_inventory_item_detail', {
      p_shipment_item_id: shipmentItemId,
    })) as any
    return {
      shipmentItemId: detail.shipmentItemId,
      itemCode: detail.itemCode ?? undefined,
      description: detail.description,
      unit: detail.unit,
      qrToken: detail.qrToken ?? undefined,
      totalQuantity: Number(detail.totalQuantity),
      packedQuantity: Number(detail.packedQuantity),
      dispatchedQuantity: Number(detail.dispatchedQuantity),
      returnedQuantity: Number(detail.returnedQuantity),
      storageQuantity: Number(detail.storageQuantity),
      shipmentId: detail.shipmentId,
      trackingNumber: detail.trackingNumber,
      shipmentStatus: detail.shipmentStatus,
      customerId: detail.customerId ?? undefined,
      customerName: detail.customerName,
      boxes: (detail.boxes ?? []).map((b: any) => ({
        boxNumber: b.boxNumber,
        packingListId: b.packingListId,
        packingListNumber: b.packingListNumber,
        packingListStatus: b.packingListStatus,
        quantity: Number(b.quantity),
      })),
      returns: (detail.returns ?? []).map((r: any) => ({
        quantity: Number(r.quantity),
        reason: r.reason ?? undefined,
        returnedBy: r.returnedBy,
        returnedAt: r.returnedAt,
      })),
    }
  },

  // --- Expenses ---
  addExpense: async (data) => {
    const row = {
      id: generateId(), date: data.date, category: data.category, description: data.description,
      amount: data.amount, currency: data.currency, reference: data.reference ?? null,
      shipment_id: data.shipmentId || null, notes: data.notes ?? null,
      payee: data.payee ?? null,
      payment_method: data.paymentMethod ?? 'Bank Transfer',
      status: 'DRAFT',
      created_at: nowISO(), created_by: data.createdBy,
    }
    let inserted = throwIfError(await supabase.from('expenses').insert(row).select().single())
    const posting = await supabase.rpc('post_expense_accounting', {
      p_expense_id: inserted.id,
      p_expense_account_code: EXPENSE_ACCOUNT_CODES[data.category] ?? '5200',
      p_payment_account_code: data.paymentMethod === 'Cash' ? '1000' : '1010',
    })
    if (posting.error) throw new Error(`Expense was saved as Draft: ${posting.error.message}`)
    const refreshed = await supabase.from('expenses').select('*').eq('id', inserted.id).single()
    if (!refreshed.error) inserted = refreshed.data
    const expense = mapExpense(inserted)
    set(s => ({ expenses: [expense, ...s.expenses] }))
    return expense
  },
  updateExpense: async (id, data) => {
    const existing = get().expenses.find(item => item.id === id)
    if (existing?.status === 'POSTED' || existing?.accountingJournalEntryId) {
      throw new Error('Posted expenses cannot be edited. Use an authorized reversal workflow.')
    }
    const patch: Record<string, unknown> = {}
    if (data.date !== undefined) patch.date = data.date
    if (data.category !== undefined) patch.category = data.category
    if (data.description !== undefined) patch.description = data.description
    if (data.amount !== undefined) patch.amount = data.amount
    if (data.currency !== undefined) patch.currency = data.currency
    if (data.reference !== undefined) patch.reference = data.reference
    if (data.shipmentId !== undefined) patch.shipment_id = data.shipmentId || null
    if (data.notes !== undefined) patch.notes = data.notes
    if (data.payee !== undefined) patch.payee = data.payee
    if (data.paymentMethod !== undefined) patch.payment_method = data.paymentMethod
    throwIfError(await supabase.from('expenses').update(patch).eq('id', id).select().single())
    set(s => ({ expenses: s.expenses.map(e => e.id === id ? { ...e, ...data } : e) }))
  },
  deleteExpense: async (id) => {
    const expense = get().expenses.find(item => item.id === id)
    if (expense?.status === 'POSTED' || expense?.accountingJournalEntryId) {
      throw new Error('Posted expenses cannot be deleted. Use an authorized reversal workflow.')
    }
    throwIfError(await supabase.from('expenses').delete().eq('id', id).select())
    set(s => ({ expenses: s.expenses.filter(e => e.id !== id) }))
  },

  // --- Settings ---
  updateSettings: async (data) => {
    const patch: Record<string, unknown> = {}
    if (data.companyName !== undefined) patch.company_name = data.companyName
    if (data.shortName !== undefined) patch.short_name = data.shortName
    if (data.logoPath !== undefined) patch.logo_path = data.logoPath
    if (data.businessType !== undefined) patch.business_type = data.businessType
    if (data.defaultCurrency !== undefined) patch.default_currency = data.defaultCurrency
    if (data.exchangeRatePolicy !== undefined) patch.exchange_rate_policy = data.exchangeRatePolicy
    if (data.defaultItemStickerSize !== undefined) patch.default_item_sticker_size = data.defaultItemStickerSize
    if (data.defaultOrigin !== undefined) patch.default_origin = data.defaultOrigin
    if (data.defaultDestinationCountry !== undefined) patch.default_destination_country = data.defaultDestinationCountry
    if (data.supportedDestinationCities !== undefined) patch.supported_destination_cities = data.supportedDestinationCities
    if (data.address !== undefined) patch.address = data.address
    if (data.phone !== undefined) patch.phone = data.phone
    if (data.whatsapp !== undefined) patch.whatsapp = data.whatsapp
    if (data.email !== undefined) patch.email = data.email
    if (data.website !== undefined) patch.website = data.website
    if (data.dubaiAddress !== undefined) patch.dubai_address = data.dubaiAddress
    if (data.dubaiPhone !== undefined) patch.dubai_phone = data.dubaiPhone
    if (data.dubaiEmail !== undefined) patch.dubai_email = data.dubaiEmail
    if (data.tanzaniaAddress !== undefined) patch.tanzania_address = data.tanzaniaAddress
    if (data.tanzaniaPhone !== undefined) patch.tanzania_phone = data.tanzaniaPhone
    if (data.tanzaniaEmail !== undefined) patch.tanzania_email = data.tanzaniaEmail
    if (data.taxId !== undefined) patch.tax_id = data.taxId
    if (data.registrationNumber !== undefined) patch.registration_number = data.registrationNumber
    if (data.bankName !== undefined) patch.bank_name = data.bankName
    if (data.bankAccount !== undefined) patch.bank_account = data.bankAccount
    if (data.bankAccountName !== undefined) patch.bank_account_name = data.bankAccountName
    if (data.bankSwift !== undefined) patch.bank_swift = data.bankSwift
    if (data.iban !== undefined) patch.iban = data.iban
    if (data.paymentInstructions !== undefined) patch.payment_instructions = data.paymentInstructions
    if (data.invoiceFooter !== undefined) patch.invoice_footer = data.invoiceFooter
    if (data.receiptFooter !== undefined) patch.receipt_footer = data.receiptFooter
    if (data.quoteFooter !== undefined) patch.quote_footer = data.quoteFooter
    if (data.packingListFooter !== undefined) patch.packing_list_footer = data.packingListFooter
    if (data.poweredByText !== undefined) patch.powered_by_text = data.poweredByText
    if (data.trackingPrefix !== undefined) patch.tracking_prefix = data.trackingPrefix
    if (data.packingListPrefix !== undefined) patch.packing_list_prefix = data.packingListPrefix
    if (data.primaryColor !== undefined) patch.primary_color = data.primaryColor
    if (data.secondaryColor !== undefined) patch.secondary_color = data.secondaryColor
    if (data.accentColor !== undefined) patch.accent_color = data.accentColor
    if (data.termsAndConditions !== undefined) patch.terms_and_conditions = data.termsAndConditions
    throwIfError(await supabase.from('company_settings').update(patch).eq('id', 'default').select().single())
    set(s => ({ settings: { ...s.settings, ...data } }))
  },
}))
