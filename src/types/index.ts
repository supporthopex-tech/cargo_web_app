import { BRAND } from '../config/brand.ts'

export type ShipmentStatus =
  | 'RECEIVED'
  | 'PACKED'
  | 'DISPATCHED'
  | 'ON_TRANSIT'
  | 'IN_CUSTOMS'
  | 'ARRIVED'
  | 'DELIVERED'

export type PaymentStatus = 'Unpaid' | 'Partially Paid' | 'Paid'
export type Currency = 'TZS' | 'USD' | 'AED'
export type ShipmentType = 'Air Cargo' | 'Sea Cargo'
export type PricingUnit = 'KG' | 'CBM'
export type ShipmentItemUnit = 'PCS' | 'BOX' | 'CARTON' | 'BAG' | 'SET' | 'PALLET' | 'UNIT' | 'OTHER'
export type ExchangeRatePolicy = 'REQUIRE_TODAY' | 'LATEST_APPROVED'
export type ExchangeRateSource = 'MANUAL' | 'API' | 'OVERRIDE'
export type ItemStickerSize = '50x30' | '60x40' | '100x50'
export type CargoCategory =
  | 'General Cargo' | 'Electronics' | 'Household Items'
  | 'Documents' | 'Commercial Goods' | 'Fragile Items'
  | 'Vehicles' | 'Other'
export type ServiceType =
  | 'Air Cargo' | 'Sea Cargo' | 'Commercial Cargo'
  | 'Personal Cargo' | 'Parcel Delivery' | 'Door-to-Door Delivery'
export type UserRole = 'Admin' | 'Manager' | 'Staff' | 'Accountant'
export type PermissionMode = 'ROLE_DEFAULT' | 'CUSTOM'

export interface User {
  id: string
  name: string
  username: string
  email: string
  phone: string
  role: UserRole
  initials: string
  active: boolean
  mustChangePassword: boolean
  avatarPath?: string
  lastLoginAt?: string
  createdBy?: string
  createdAt: string
  updatedAt?: string
  permissionsMode: PermissionMode
  permissions: string[]
}

export interface Customer {
  id: string
  name: string
  company: string
  phone: string
  email: string
  address: string
  city: string
  notes?: string
  archivedAt?: string
  archivedBy?: string
  archivedReason?: string
  createdAt: string
  updatedAt: string
}

export interface PaymentRecord {
  id: string
  receiptNumber: string
  /** Null once the shipment it was recorded against has been deleted via
   *  "Delete Shipment & Keep Financial Record" — the payment itself is
   *  never deleted, only detached. Fall back to shipmentTrackingSnapshot
   *  for display in that case. */
  shipmentId?: string
  /** The shipment id this payment was originally recorded against, kept
   *  even after shipmentId is nulled out by a shipment delete. */
  shipmentIdSnapshot?: string
  /** The shipment's tracking number at the moment it was deleted — the only
   *  way to show "which shipment" for a payment whose shipment is gone. */
  shipmentTrackingSnapshot?: string
  amount: number
  currency: Currency
  method: string
  date: string
  note?: string
  createdAt: string
  createdBy: string
  status?: AccountingStatus
  receivingAccountId?: string
  exchangeRate?: number
  reportingAmount?: number
  accountingJournalEntryId?: string
  idempotencyKey?: string
}

export interface CreatePaymentInput {
  shipmentId: string
  amount: number
  currency: Currency
  method: string
  date: string
  note?: string
  idempotencyKey: string
}

export interface PaymentRefund {
  id: string
  paymentId: string
  refundAmount: number
  currency: Currency
  refundMethod?: string
  refundDate: string
  reason: string
  processedBy?: string
  processedByName: string
  accountingJournalEntryId?: string
  createdAt: string
}

export interface StatusEvent {
  status: ShipmentStatus
  previousStatus?: ShipmentStatus
  location?: string
  timestamp: string
  staff?: string
  note?: string
  internalNote?: string
  isPublic?: boolean
  customsType?: CustomsType
  customsLocation?: string
  dispatchReference?: string
  isCorrection?: boolean
  correctionReason?: string
}

export type CustomsType = 'AIRPORT' | 'SEA_PORT'

export interface DeliveryConfirmation {
  recipientName: string
  recipientPhone?: string
  deliveredAt: string
  releasedBy?: string
  notes?: string
  proofStoragePath?: string
}

export interface StatusTransitionInput {
  status: ShipmentStatus
  location?: string
  publicNote?: string
  internalNote?: string
  customsType?: CustomsType
  customsLocation?: string
  dispatchReference?: string
  correctionReason?: string
  delivery?: DeliveryConfirmation
}

export interface ShipmentItem {
  id?: string
  itemNumber: number
  itemCode?: string
  description: string
  quantity: number
  unit: ShipmentItemUnit
  sortOrder: number
  qrToken?: string
  qrCreatedAt?: string
}

export interface ShippingRate {
  id: string
  shippingMethod: ShipmentType
  currency: 'USD'
  pricingUnit: PricingUnit
  rate: number
  effectiveFrom: string
  effectiveTo?: string
  isActive: boolean
  createdBy?: string
  updatedBy?: string
  createdAt: string
  updatedAt: string
}

export interface ExchangeRate {
  id: string
  rateDate: string
  baseCurrency: 'USD'
  usdToTzs: number
  usdToAed: number
  source: ExchangeRateSource
  notes?: string
  createdBy?: string
  updatedBy?: string
  createdAt: string
  updatedAt: string
}

export interface Shipment {
  id: string
  trackingNumber: string
  status: ShipmentStatus
  shipmentType: ShipmentType
  cargoCategory: CargoCategory
  serviceType: ServiceType
  customerId: string
  origin: string
  destination: string
  destinationCity: string
  description: string
  items: ShipmentItem[]
  weightKg: number
  volumeCbm: number
  pcs: number
  shippingRate: string
  baseRate: number
  otherCharges: number
  discount: number
  totalAmount: number
  amountPaid: number
  currency: Currency
  customerNameSnapshot?: string
  customerPhoneSnapshot?: string
  customerEmailSnapshot?: string
  pricingUnit?: PricingUnit
  standardRateUsd?: number
  appliedRateUsd?: number
  rateOverridden: boolean
  overrideReason?: string
  overriddenBy?: string
  overrideTimestamp?: string
  baseCurrency: 'USD'
  baseAmountUsd?: number
  usdToTzsRateUsed?: number
  usdToAedRateUsed?: number
  selectedExchangeRate?: number
  exchangeRateDate?: string
  invoiceCurrency?: Currency
  invoiceAmount?: number
  invoiceNumber?: string
  invoiceFinalizedAt?: string
  packingListId?: string
  isOnHold?: boolean
  holdReason?: string
  heldAt?: string
  customsType?: CustomsType
  customsLocation?: string
  customsStartedAt?: string
  dispatchReference?: string
  dispatchedAt?: string
  arrivedAt?: string
  deliveredAt?: string
  accountingJournalEntryId?: string
  voidedAt?: string
  voidedBy?: string
  voidedReason?: string
  notes?: string
  statusHistory: StatusEvent[]
  createdAt: string
  updatedAt: string
  createdBy: string
}

export interface PackingList {
  id: string
  listId: string
  status: 'Draft' | 'Closed' | 'Dispatched'
  shipmentIds: string[]
  origin: string
  destination: string
  shipmentType: ShipmentType
  notes?: string
  createdAt: string
  updatedAt: string
  dispatchedAt?: string
  closedAt?: string
  closedBy?: string
  createdBy: string
}

export interface PackingBox {
  id: string
  packingListId: string
  boxNumber: number
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface PackingAllocation {
  id: string
  packingListId: string
  boxId: string
  shipmentItemId: string
  quantity: number
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export type ExpenseCategory =
  | 'Office Rent' | 'Staff Salaries' | 'Transport' | 'Customs & Duties'
  | 'Packing Materials' | 'Airport Charges' | 'Port Charges'
  | 'Banking Fees' | 'Marketing' | 'Utilities' | 'Internet / Phone'
  | 'Fuel' | 'Maintenance' | 'General Expenses' | 'Other'

export interface Expense {
  idempotencyKey?: string
  id: string
  date: string
  category: ExpenseCategory
  description: string
  amount: number
  currency: Currency
  reference?: string
  shipmentId?: string
  notes?: string
  createdAt: string
  createdBy: string
  expenseNumber?: string
  payee?: string
  paymentMethod?: string
  expenseAccountId?: string
  paymentAccountId?: string
  exchangeRate?: number
  reportingAmount?: number
  status?: AccountingStatus
  accountingJournalEntryId?: string
  receiptStoragePath?: string
}

export type CargoExtraChargeType =
  | 'export_packing'
  | 'pickup'
  | 'forklift'
  | 'warehouse'
  | 'dg_packing'
  | 'supplier_payment'
  | 'other'

export type ChargeDirection = 'billable_to_customer' | 'company_expense'

export interface CargoExtraCharge {
  id: string
  shipmentId: string
  chargeType: CargoExtraChargeType
  customLabel?: string
  direction: ChargeDirection
  amount: number
  currency: Currency
  chargeDate: string
  note?: string
  paymentMethod?: string
  status: 'ACTIVE' | 'DELETED'
  idempotencyKey?: string
  exchangeRate?: number
  reportingAmount?: number
  accountingJournalEntryId?: string
  createdBy?: string
  createdAt: string
  updatedBy?: string
  updatedAt: string
  deletedBy?: string
  deletedAt?: string
}

export interface CargoExtraChargeInput {
  shipmentId: string
  chargeType: CargoExtraChargeType
  customLabel?: string
  direction: ChargeDirection
  amount: number
  currency: Currency
  chargeDate: string
  note?: string
  paymentMethod?: string
  idempotencyKey: string
}

export type AccountingStatus = 'DRAFT' | 'POSTED' | 'VOIDED' | 'REFUNDED'
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
export type NormalBalance = 'DEBIT' | 'CREDIT'

export interface AccountingAccount {
  id: string
  code: string
  name: string
  accountType: AccountType
  normalBalance: NormalBalance
  parentId?: string
  active: boolean
  systemAccount: boolean
  allowManualPosting: boolean
}

export interface JournalEntry {
  id: string
  entryNumber: string
  entryDate: string
  description: string
  referenceType: 'INVOICE' | 'PAYMENT' | 'EXPENSE' | 'OTHER_INCOME' | 'REVERSAL' | string
  referenceId: string
  currency: Currency
  exchangeRate: number
  originalAmount: number
  baseAmount: number
  status: AccountingStatus
  reversalOf?: string
  correctionReason?: string
  createdBy?: string
  postedBy?: string
  createdAt: string
  postedAt?: string
}

export interface JournalLine {
  id: string
  journalEntryId: string
  accountId: string
  description?: string
  debit: number
  credit: number
  originalDebit: number
  originalCredit: number
}

export interface OtherIncome {
  id: string
  incomeNumber: string
  incomeDate: string
  incomeAccountId: string
  receivingAccountId: string
  description: string
  amount: number
  currency: Currency
  exchangeRate: number
  reportingAmount: number
  reference?: string
  status: AccountingStatus
  accountingJournalEntryId?: string
  createdBy: string
}

export interface CompanySettings {
  companyName: string
  shortName: string
  logoPath: string
  businessType: string
  defaultCurrency: Currency
  exchangeRatePolicy: ExchangeRatePolicy
  defaultItemStickerSize: ItemStickerSize
  defaultOrigin: string
  defaultDestinationCountry: string
  supportedDestinationCities: string[]
  address: string
  phone: string
  whatsapp: string
  email: string
  website: string
  dubaiAddress: string
  dubaiPhone: string
  dubaiEmail: string
  tanzaniaAddress: string
  tanzaniaPhone: string
  tanzaniaEmail: string
  taxId: string
  registrationNumber: string
  bankName: string
  bankAccount: string
  bankAccountName: string
  bankSwift: string
  iban: string
  paymentInstructions: string
  invoiceFooter: string
  receiptFooter: string
  quoteFooter: string
  packingListFooter: string
  poweredByText: string
  trackingPrefix: string
  packingListPrefix: string
  primaryColor: string
  secondaryColor: string
  accentColor: string
  termsAndConditions: string
}

export const DEFAULT_SETTINGS: CompanySettings = {
  companyName: BRAND.companyName,
  shortName: BRAND.shortName,
  logoPath: '',
  businessType: 'International Cargo & Freight Forwarding',
  defaultCurrency: 'TZS',
  exchangeRatePolicy: 'REQUIRE_TODAY',
  defaultItemStickerSize: '60x40',
  defaultOrigin: 'Dubai, UAE',
  defaultDestinationCountry: 'Tanzania',
  supportedDestinationCities: [
    'Dar es Salaam','Zanzibar','Arusha','Dodoma','Mwanza',
    'Mbeya','Morogoro','Tanga','Kigoma','Tabora','Mtwara',
    'Iringa','Moshi','Songea','Other',
  ],
  address: '',
  phone: '',
  whatsapp: '',
  email: '',
  website: '',
  dubaiAddress: '',
  dubaiPhone: '',
  dubaiEmail: '',
  tanzaniaAddress: '',
  tanzaniaPhone: '',
  tanzaniaEmail: '',
  taxId: '',
  registrationNumber: '',
  bankName: '',
  bankAccount: '',
  bankAccountName: '',
  bankSwift: '',
  iban: '',
  paymentInstructions: '',
  invoiceFooter: '',
  receiptFooter: '',
  quoteFooter: '',
  packingListFooter: '',
  poweredByText: '',
  trackingPrefix: BRAND.code,
  packingListPrefix: `PL-${BRAND.code}`,
  primaryColor: '#0c1c35',
  secondaryColor: '#0a84d3',
  accentColor: '#2f80ed',
  termsAndConditions: '',
}

export const TANZANIA_CITIES = [
  'Dar es Salaam','Zanzibar','Arusha','Dodoma','Mwanza',
  'Mbeya','Morogoro','Tanga','Kigoma','Tabora','Mtwara',
  'Iringa','Moshi','Songea','Other',
]

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  TZS: 'TZS', USD: '$', AED: 'AED',
}

export function formatAmount(amount: number, currency: Currency): string {
  if (currency === 'TZS') return `TZS ${amount.toLocaleString()}`
  if (currency === 'USD') return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `AED ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function getPaymentStatus(amountPaid: number, totalAmount: number): PaymentStatus {
  if (amountPaid <= 0) return 'Unpaid'
  if (amountPaid >= totalAmount) return 'Paid'
  return 'Partially Paid'
}

export const STATUS_ORDER: ShipmentStatus[] = [
  'RECEIVED','PACKED','DISPATCHED','ON_TRANSIT',
  'IN_CUSTOMS','ARRIVED','DELIVERED',
]

export const STATUS_LABELS: Record<ShipmentStatus, string> = {
  RECEIVED: 'Received at Dubai Office',
  PACKED: 'Packed for Dispatch',
  DISPATCHED: 'Dispatched from Dubai',
  ON_TRANSIT: 'On Transit to Tanzania',
  IN_CUSTOMS: 'In Customs',
  ARRIVED: 'Arrived at Tanzania Office',
  DELIVERED: 'Delivered',
}

export function shipmentStatusLabel(status: ShipmentStatus): string {
  return STATUS_LABELS[status]
}

// ---------------------------------------------------------------------------
// Storage / Inventory — read-only, server-computed. See
// search_inventory()/get_inventory_item_detail() in
// supabase/migrations/20260817184710_storage_inventory.sql for the
// authoritative formulas; the frontend never recomputes these quantities.
// ---------------------------------------------------------------------------

export type InventoryPackingStatus = 'NOT_PACKED' | 'PARTIALLY_PACKED' | 'FULLY_PACKED'

export interface InventoryRow {
  shipmentItemId: string
  itemCode?: string
  description: string
  unit: string
  totalQuantity: number
  packedQuantity: number
  dispatchedQuantity: number
  returnedQuantity: number
  storageQuantity: number
  shipmentId: string
  trackingNumber: string
  shipmentStatus: ShipmentStatus
  customerId?: string
  customerName: string
  lastUpdated?: string
}

export interface InventoryFilters {
  search?: string
  customerId?: string
  trackingNumber?: string
  packingStatus?: InventoryPackingStatus
  returnedOnly?: boolean
}

export interface InventoryBoxEntry {
  boxNumber: number
  packingListId: string
  packingListNumber: string
  packingListStatus: 'Draft' | 'Closed' | 'Dispatched'
  quantity: number
}

export interface InventoryReturnEntry {
  quantity: number
  reason?: string
  returnedBy: string
  returnedAt: string
}

export interface InventoryItemDetail {
  shipmentItemId: string
  itemCode?: string
  description: string
  unit: string
  qrToken?: string
  totalQuantity: number
  packedQuantity: number
  dispatchedQuantity: number
  returnedQuantity: number
  storageQuantity: number
  shipmentId: string
  trackingNumber: string
  shipmentStatus: ShipmentStatus
  customerId?: string
  customerName: string
  boxes: InventoryBoxEntry[]
  returns: InventoryReturnEntry[]
}

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'Office Rent','Staff Salaries','Transport','Customs & Duties',
  'Packing Materials','Airport Charges','Port Charges','Banking Fees',
  'Marketing','Utilities','Internet / Phone','Fuel','Maintenance',
  'General Expenses','Other',
]

export const CARGO_EXTRA_CHARGE_LABELS: Record<CargoExtraChargeType, string> = {
  export_packing: 'Export Packing Charges',
  pickup: 'Pickup Charges',
  forklift: 'Forklift Charges',
  warehouse: 'Warehouse Charges',
  dg_packing: 'DG Packing Charges',
  supplier_payment: 'Supplier Payment',
  other: 'Other',
}

export const CARGO_EXTRA_CHARGE_TYPES = Object.keys(CARGO_EXTRA_CHARGE_LABELS) as CargoExtraChargeType[]

export const DEFAULT_CHARGE_DIRECTION: Record<CargoExtraChargeType, ChargeDirection> = {
  export_packing: 'billable_to_customer',
  pickup: 'billable_to_customer',
  forklift: 'billable_to_customer',
  warehouse: 'billable_to_customer',
  dg_packing: 'billable_to_customer',
  supplier_payment: 'company_expense',
  other: 'company_expense',
}
