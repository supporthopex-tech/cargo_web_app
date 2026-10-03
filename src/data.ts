export type ShipmentStatus =
  | 'Received'
  | 'Processing'
  | 'Packed'
  | 'Dispatched'
  | 'In Transit'
  | 'Arrived'
  | 'Ready for Collection'
  | 'Delivered'
  | 'On Hold'

export type PaymentStatus = 'Unpaid' | 'Partially Paid' | 'Paid'

export type Currency = 'TZS' | 'USD' | 'AED'

export type ShipmentType = 'Air Cargo' | 'Sea Cargo'

export type CargoCategory =
  | 'General Cargo'
  | 'Electronics'
  | 'Household Items'
  | 'Documents'
  | 'Commercial Goods'
  | 'Fragile Items'
  | 'Vehicles'
  | 'Other'

export type ServiceType =
  | 'Air Cargo'
  | 'Sea Cargo'
  | 'Commercial Cargo'
  | 'Personal Cargo'
  | 'Parcel Delivery'
  | 'Door-to-Door Delivery'

export const TANZANIA_CITIES = [
  'Dar es Salaam',
  'Zanzibar',
  'Arusha',
  'Dodoma',
  'Mwanza',
  'Mbeya',
  'Morogoro',
  'Tanga',
  'Kigoma',
  'Tabora',
  'Mtwara',
  'Iringa',
  'Moshi',
  'Songea',
  'Other',
]

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  TZS: 'TZS',
  USD: '$',
  AED: 'AED',
}

export const CURRENCY_RATES: Record<Currency, number> = {
  TZS: 1,
  USD: 2700,
  AED: 735,
}

export function formatAmount(amount: number, currency: Currency): string {
  if (currency === 'TZS') {
    return `TZS ${amount.toLocaleString()}`
  }
  if (currency === 'USD') {
    return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  return `AED ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export interface Payment {
  id: string
  receiptNumber: string
  amount: number
  currency: Currency
  method: string
  date: string
  note?: string
}

export interface StatusEvent {
  status: ShipmentStatus
  location: string
  timestamp: string
  staff: string
  note: string
  isPublic: boolean
}

export interface Shipment {
  id: string
  trackingNumber: string
  status: ShipmentStatus
  shipmentType: ShipmentType
  cargoCategory: CargoCategory
  serviceType: ServiceType
  customer: string
  customerId: string
  origin: string
  destination: string
  destinationCity: string
  description: string
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
  createdAt: string
  updatedAt: string
  packingListId?: string
  paymentHistory: Payment[]
  statusHistory: StatusEvent[]
}

export interface Customer {
  id: string
  name: string
  company: string
  phone: string
  email: string
  address: string
  city: string
}

export interface PackingList {
  id: string
  listId: string
  status: 'Draft' | 'Dispatched'
  shipmentIds: string[]
  createdAt: string
  dispatchedAt?: string
  origin: string
  destination: string
  shipmentType: ShipmentType
}

export const customers: Customer[] = [
  {
    id: 'C001',
    name: 'Mohamed Hassan',
    company: 'Hassan Trading Co. Ltd',
    phone: '+255 712 345 678',
    email: 'mhassan@hassantrading.co.tz',
    address: 'Kariakoo, Lindi Street, Plot 22',
    city: 'Dar es Salaam',
  },
  {
    id: 'C002',
    name: 'Fatuma Rashid',
    company: 'Zanzibar Gulf Imports',
    phone: '+255 777 123 456',
    email: 'fatuma@zanzibargulf.com',
    address: 'Darajani Market Area, Stone Town',
    city: 'Zanzibar',
  },
  {
    id: 'C003',
    name: 'Joseph Mwangi',
    company: 'Mwangi Electronics Ltd',
    phone: '+255 768 900 112',
    email: 'joseph@mwangielectronics.co.tz',
    address: 'Sokoine Road, Shop 14',
    city: 'Arusha',
  },
  {
    id: 'C004',
    name: 'Amina Juma',
    company: 'Amina Home Supplies',
    phone: '+255 653 441 880',
    email: 'amina@aminahome.co.tz',
    address: 'Pamba Road, Mwanza Central',
    city: 'Mwanza',
  },
  {
    id: 'C005',
    name: 'Salim Al-Barwani',
    company: 'Al-Barwani General Trading',
    phone: '+255 784 667 234',
    email: 'salim@albarwani.co.tz',
    address: 'New Street, Moshi Town',
    city: 'Moshi',
  },
]

export const shipments: Shipment[] = [
  {
    id: 'S001',
    trackingNumber: 'HOPEX-260804-0001',
    status: 'In Transit',
    shipmentType: 'Air Cargo',
    cargoCategory: 'Electronics',
    serviceType: 'Commercial Cargo',
    customer: 'Mwangi Electronics Ltd',
    customerId: 'C003',
    origin: 'Dubai, UAE',
    destination: 'Tanzania',
    destinationCity: 'Arusha',
    description: 'Electronic Components — Smartphones, Tablets, Chargers (Mixed Brands)',
    weightKg: 342.5,
    volumeCbm: 2.8,
    pcs: 24,
    shippingRate: 'Air Cargo Express',
    baseRate: 3_800_000,
    otherCharges: 420_000,
    discount: 0,
    totalAmount: 4_220_000,
    amountPaid: 2_100_000,
    currency: 'TZS',
    createdAt: '2026-07-28',
    updatedAt: '2026-08-02',
    packingListId: 'PL001',
    paymentHistory: [
      { id: 'P001', receiptNumber: 'RCT-260728-0001', amount: 2_100_000, currency: 'TZS', method: 'Bank Transfer', date: '2026-07-28', note: 'Deposit — 50%' },
    ],
    statusHistory: [
      { status: 'Received', location: 'HOPEX Warehouse, Dubai DIP', timestamp: '2026-07-28 09:15', staff: 'Ahmed Khalil', note: 'Received 24 cartons. Electronics verified and insured.', isPublic: true },
      { status: 'Processing', location: 'HOPEX Warehouse, Dubai DIP', timestamp: '2026-07-29 11:30', staff: 'Ahmed Khalil', note: 'Export documentation filed. Emirates Customs cleared.', isPublic: true },
      { status: 'Packed', location: 'HOPEX Warehouse, Dubai DIP', timestamp: '2026-07-30 14:00', staff: 'Rajan Kumar', note: 'Packed and sealed. AWB: EK-7823650.', isPublic: true },
      { status: 'Dispatched', location: 'Dubai International Airport', timestamp: '2026-08-01 06:45', staff: 'Rajan Kumar', note: 'Loaded on EK717 Dubai → Kilimanjaro. ETD 08:00.', isPublic: true },
      { status: 'In Transit', location: 'En route to Kilimanjaro, TZ', timestamp: '2026-08-02 08:00', staff: 'System', note: 'Flight EK717 airborne. ETA KIA: 2026-08-02 13:00.', isPublic: true },
    ],
  },
  {
    id: 'S002',
    trackingNumber: 'HOPEX-260801-0002',
    status: 'Arrived',
    shipmentType: 'Sea Cargo',
    cargoCategory: 'Household Items',
    serviceType: 'Personal Cargo',
    customer: 'Fatuma Rashid',
    customerId: 'C002',
    origin: 'Dubai, UAE',
    destination: 'Tanzania',
    destinationCity: 'Zanzibar',
    description: 'Personal Effects — Kitchen Appliances, Bedding, Furniture Parts',
    weightKg: 580,
    volumeCbm: 6.2,
    pcs: 48,
    shippingRate: 'Sea Cargo LCL',
    baseRate: 1_980_000,
    otherCharges: 380_000,
    discount: 100_000,
    totalAmount: 2_260_000,
    amountPaid: 2_260_000,
    currency: 'TZS',
    createdAt: '2026-08-01',
    updatedAt: '2026-08-04',
    packingListId: 'PL001',
    paymentHistory: [
      { id: 'P002', receiptNumber: 'RCT-260801-0002', amount: 1_130_000, currency: 'TZS', method: 'Cash', date: '2026-08-01', note: 'Initial deposit' },
      { id: 'P003', receiptNumber: 'RCT-260803-0003', amount: 1_130_000, currency: 'TZS', method: 'M-Pesa', date: '2026-08-03', note: 'Final payment on arrival' },
    ],
    statusHistory: [
      { status: 'Received', location: 'HOPEX Warehouse, Jebel Ali FZ', timestamp: '2026-08-01 10:00', staff: 'Ibrahim Nasser', note: 'Received 48 cartons. Personal effects inventoried.', isPublic: true },
      { status: 'Processing', location: 'HOPEX Warehouse, Jebel Ali FZ', timestamp: '2026-08-01 15:00', staff: 'Ibrahim Nasser', note: 'Packing list signed. Jebel Ali customs cleared.', isPublic: true },
      { status: 'Packed', location: 'Jebel Ali Port, Dubai', timestamp: '2026-08-02 09:00', staff: 'Ibrahim Nasser', note: 'Loaded into container TCKU-4420881.', isPublic: true },
      { status: 'Dispatched', location: 'Jebel Ali Port, Dubai', timestamp: '2026-08-02 20:00', staff: 'System', note: 'MV MSC Zanzibar departed. ETA Zanzibar Port: 2026-08-04.', isPublic: true },
      { status: 'In Transit', location: 'Indian Ocean', timestamp: '2026-08-03 14:00', staff: 'System', note: 'Vessel in transit, ETA 20 hours.', isPublic: true },
      { status: 'Arrived', location: 'Zanzibar Port, Tanzania', timestamp: '2026-08-04 07:30', staff: 'Omar Abdullah', note: 'Vessel arrived. TRA customs clearance in progress.', isPublic: true },
    ],
  },
  {
    id: 'S003',
    trackingNumber: 'HOPEX-260803-0003',
    status: 'Processing',
    shipmentType: 'Air Cargo',
    cargoCategory: 'Commercial Goods',
    serviceType: 'Commercial Cargo',
    customer: 'Hassan Trading Co. Ltd',
    customerId: 'C001',
    origin: 'Dubai, UAE',
    destination: 'Tanzania',
    destinationCity: 'Dar es Salaam',
    description: 'Wholesale Goods — Clothing, Footwear, Bags (Mixed)',
    weightKg: 220,
    volumeCbm: 3.1,
    pcs: 18,
    shippingRate: 'Air Cargo Standard',
    baseRate: 2_420_000,
    otherCharges: 310_000,
    discount: 130_000,
    totalAmount: 2_600_000,
    amountPaid: 0,
    currency: 'TZS',
    createdAt: '2026-08-03',
    updatedAt: '2026-08-04',
    paymentHistory: [],
    statusHistory: [
      { status: 'Received', location: 'HOPEX Warehouse, Dubai DIP', timestamp: '2026-08-03 13:45', staff: 'Rajan Kumar', note: 'Received 18 cartons of mixed goods. Weight confirmed.', isPublic: true },
      { status: 'Processing', location: 'HOPEX Warehouse, Dubai DIP', timestamp: '2026-08-04 09:00', staff: 'Rajan Kumar', note: 'Tanzania import declaration form being prepared. Awaiting commercial invoice.', isPublic: true },
    ],
  },
  {
    id: 'S004',
    trackingNumber: 'HOPEX-260729-0004',
    status: 'Ready for Collection',
    shipmentType: 'Sea Cargo',
    cargoCategory: 'Commercial Goods',
    serviceType: 'Door-to-Door Delivery',
    customer: 'Al-Barwani General Trading',
    customerId: 'C005',
    origin: 'Dubai, UAE',
    destination: 'Tanzania',
    destinationCity: 'Moshi',
    description: 'Hardware & Tools — Power Drills, Safety Equipment, Fittings',
    weightKg: 890,
    volumeCbm: 12.5,
    pcs: 6,
    shippingRate: 'Sea Cargo FCL 20ft',
    baseRate: 3_500_000,
    otherCharges: 600_000,
    discount: 200_000,
    totalAmount: 3_900_000,
    amountPaid: 1_950_000,
    currency: 'TZS',
    createdAt: '2026-07-29',
    updatedAt: '2026-08-04',
    paymentHistory: [
      { id: 'P004', receiptNumber: 'RCT-260729-0004', amount: 1_950_000, currency: 'TZS', method: 'Bank Transfer', date: '2026-07-29', note: '50% deposit' },
    ],
    statusHistory: [
      { status: 'Received', location: 'HOPEX Warehouse, Jebel Ali FZ', timestamp: '2026-07-29 11:00', staff: 'Ibrahim Nasser', note: '6 pallets received. Fumigation certificate obtained.', isPublic: true },
      { status: 'Processing', location: 'HOPEX Warehouse, Jebel Ali FZ', timestamp: '2026-07-30 09:00', staff: 'Ibrahim Nasser', note: 'Export declaration filed. UAE customs cleared.', isPublic: true },
      { status: 'Packed', location: 'Jebel Ali Port, Dubai', timestamp: '2026-07-31 16:00', staff: 'Ibrahim Nasser', note: 'Loaded in container MSKU-7710234.', isPublic: true },
      { status: 'Dispatched', location: 'Jebel Ali Port, Dubai', timestamp: '2026-08-01 22:00', staff: 'System', note: 'Vessel MV Maersk Dar Es Salaam departed.', isPublic: true },
      { status: 'In Transit', location: 'Arabian Sea', timestamp: '2026-08-02 06:00', staff: 'System', note: 'ETA Dar es Salaam Port: 2026-08-04.', isPublic: true },
      { status: 'Arrived', location: 'Dar es Salaam Port, Tanzania', timestamp: '2026-08-04 04:15', staff: 'Juma Mrisho', note: 'Arrived. TRA customs cleared. Delivery to Moshi in progress.', isPublic: true },
      { status: 'Ready for Collection', location: 'HOPEX Agent, Moshi', timestamp: '2026-08-04 14:00', staff: 'Juma Mrisho', note: 'Ready at our Moshi agent. Please settle remaining balance TZS 1,950,000 before collection.', isPublic: true },
    ],
  },
  {
    id: 'S005',
    trackingNumber: 'HOPEX-260802-0005',
    status: 'On Hold',
    shipmentType: 'Air Cargo',
    cargoCategory: 'General Cargo',
    serviceType: 'Commercial Cargo',
    customer: 'Amina Home Supplies',
    customerId: 'C004',
    origin: 'Dubai, UAE',
    destination: 'Tanzania',
    destinationCity: 'Mwanza',
    description: 'Textile Rolls — Polyester, Cotton Blend, Linen (30 Rolls)',
    weightKg: 430,
    volumeCbm: 3.6,
    pcs: 30,
    shippingRate: 'Air Cargo Standard',
    baseRate: 4_730_000,
    otherCharges: 520_000,
    discount: 0,
    totalAmount: 5_250_000,
    amountPaid: 0,
    currency: 'TZS',
    createdAt: '2026-08-02',
    updatedAt: '2026-08-04',
    paymentHistory: [],
    statusHistory: [
      { status: 'Received', location: 'HOPEX Warehouse, Dubai DIP', timestamp: '2026-08-02 10:30', staff: 'Ahmed Khalil', note: 'Received 30 rolls of textile. Condition good.', isPublic: true },
      { status: 'Processing', location: 'HOPEX Warehouse, Dubai DIP', timestamp: '2026-08-03 09:00', staff: 'Ahmed Khalil', note: 'Tanzania TBS import permit required for textile goods.', isPublic: false },
      { status: 'On Hold', location: 'HOPEX Warehouse, Dubai DIP', timestamp: '2026-08-04 10:00', staff: 'Rajan Kumar', note: 'Shipment on hold — TBS import permit not received. Customer notified via WhatsApp.', isPublic: true },
    ],
  },
  {
    id: 'S006',
    trackingNumber: 'HOPEX-260725-0006',
    status: 'Delivered',
    shipmentType: 'Sea Cargo',
    cargoCategory: 'Household Items',
    serviceType: 'Door-to-Door Delivery',
    customer: 'Hassan Trading Co. Ltd',
    customerId: 'C001',
    origin: 'Dubai, UAE',
    destination: 'Tanzania',
    destinationCity: 'Dar es Salaam',
    description: 'Household Goods — Refrigerator, Washing Machine, LED TV (3 Units)',
    weightKg: 760,
    volumeCbm: 5.1,
    pcs: 3,
    shippingRate: 'Sea Cargo LCL',
    baseRate: 2_700_000,
    otherCharges: 480_000,
    discount: 180_000,
    totalAmount: 3_000_000,
    amountPaid: 3_000_000,
    currency: 'TZS',
    createdAt: '2026-07-25',
    updatedAt: '2026-08-03',
    paymentHistory: [
      { id: 'P005', receiptNumber: 'RCT-260725-0005', amount: 1_500_000, currency: 'TZS', method: 'Bank Transfer', date: '2026-07-25', note: '50% deposit' },
      { id: 'P006', receiptNumber: 'RCT-260803-0006', amount: 1_500_000, currency: 'TZS', method: 'M-Pesa', date: '2026-08-03', note: 'Balance payment' },
    ],
    statusHistory: [
      { status: 'Received', location: 'HOPEX Warehouse, Jebel Ali FZ', timestamp: '2026-07-25 09:00', staff: 'Ibrahim Nasser', note: 'Received 3 units. Original packaging intact.', isPublic: true },
      { status: 'Processing', location: 'HOPEX Warehouse, Jebel Ali FZ', timestamp: '2026-07-26 10:00', staff: 'Ibrahim Nasser', note: 'Export declaration filed.', isPublic: true },
      { status: 'Packed', location: 'Jebel Ali Port, Dubai', timestamp: '2026-07-27 14:00', staff: 'Ibrahim Nasser', note: 'Loaded in container.', isPublic: true },
      { status: 'Dispatched', location: 'Jebel Ali Port, Dubai', timestamp: '2026-07-28 20:00', staff: 'System', note: 'Departed on MV MSC Dar Es Salaam.', isPublic: true },
      { status: 'In Transit', location: 'Indian Ocean', timestamp: '2026-07-29 08:00', staff: 'System', note: 'ETA Dar es Salaam Port: 2026-08-02.', isPublic: true },
      { status: 'Arrived', location: 'Dar es Salaam Port, Tanzania', timestamp: '2026-08-02 05:00', staff: 'Juma Mrisho', note: 'Arrived. TRA customs cleared.', isPublic: true },
      { status: 'Ready for Collection', location: 'HOPEX Warehouse, Kariakoo, DSM', timestamp: '2026-08-02 16:00', staff: 'Juma Mrisho', note: 'Goods available for collection.', isPublic: true },
      { status: 'Delivered', location: 'Kariakoo, Dar es Salaam', timestamp: '2026-08-03 11:00', staff: 'Ali Juma (Driver)', note: 'Delivered to customer. POD signed by Mohamed Hassan.', isPublic: true },
    ],
  },
  {
    id: 'S007',
    trackingNumber: 'HOPEX-260804-0007',
    status: 'Received',
    shipmentType: 'Air Cargo',
    cargoCategory: 'Commercial Goods',
    serviceType: 'Commercial Cargo',
    customer: 'Zanzibar Gulf Imports',
    customerId: 'C002',
    origin: 'Dubai, UAE',
    destination: 'Tanzania',
    destinationCity: 'Zanzibar',
    description: 'Perfumes & Cosmetics — Branded Fragrances, Skincare (Wholesale)',
    weightKg: 185,
    volumeCbm: 1.8,
    pcs: 22,
    shippingRate: 'Air Cargo Express',
    baseRate: 2_050_000,
    otherCharges: 380_000,
    discount: 130_000,
    totalAmount: 2_300_000,
    amountPaid: 1_150_000,
    currency: 'TZS',
    createdAt: '2026-08-04',
    updatedAt: '2026-08-04',
    packingListId: 'PL002',
    paymentHistory: [
      { id: 'P007', receiptNumber: 'RCT-260804-0007', amount: 1_150_000, currency: 'TZS', method: 'Cash', date: '2026-08-04', note: '50% deposit' },
    ],
    statusHistory: [
      { status: 'Received', location: 'HOPEX Warehouse, Dubai DIP', timestamp: '2026-08-04 08:45', staff: 'Ahmed Khalil', note: 'Received 22 cartons. Fragrance items checked — no prohibited items.', isPublic: true },
    ],
  },
  {
    id: 'S008',
    trackingNumber: 'HOPEX-260804-0008',
    status: 'Received',
    shipmentType: 'Sea Cargo',
    cargoCategory: 'General Cargo',
    serviceType: 'Parcel Delivery',
    customer: 'Amina Home Supplies',
    customerId: 'C004',
    origin: 'Dubai, UAE',
    destination: 'Tanzania',
    destinationCity: 'Mwanza',
    description: 'Building Materials — Floor Tiles, Grout, Adhesive (Assorted)',
    weightKg: 1_240,
    volumeCbm: 8.3,
    pcs: 80,
    shippingRate: 'Sea Cargo FCL 20ft',
    baseRate: 3_200_000,
    otherCharges: 620_000,
    discount: 220_000,
    totalAmount: 3_600_000,
    amountPaid: 1_800_000,
    currency: 'TZS',
    createdAt: '2026-08-04',
    updatedAt: '2026-08-04',
    packingListId: 'PL002',
    paymentHistory: [
      { id: 'P008', receiptNumber: 'RCT-260804-0008', amount: 1_800_000, currency: 'TZS', method: 'Bank Transfer', date: '2026-08-04', note: 'Deposit' },
    ],
    statusHistory: [
      { status: 'Received', location: 'HOPEX Warehouse, Jebel Ali FZ', timestamp: '2026-08-04 11:15', staff: 'Ibrahim Nasser', note: 'Received 80 boxes of building materials. Ready for processing.', isPublic: true },
    ],
  },
]

export const packingLists: PackingList[] = [
  {
    id: 'PL001',
    listId: 'PL-HOPEX-260801-001',
    status: 'Dispatched',
    shipmentIds: ['S001', 'S002'],
    createdAt: '2026-08-01',
    dispatchedAt: '2026-08-02',
    origin: 'Dubai, UAE',
    destination: 'Arusha / Zanzibar, Tanzania',
    shipmentType: 'Air Cargo',
  },
  {
    id: 'PL002',
    listId: 'PL-HOPEX-260804-002',
    status: 'Draft',
    shipmentIds: ['S007', 'S008'],
    createdAt: '2026-08-04',
    origin: 'Dubai, UAE',
    destination: 'Zanzibar / Mwanza, Tanzania',
    shipmentType: 'Sea Cargo',
  },
]

export function getPaymentStatus(shipment: Shipment): PaymentStatus {
  if (shipment.amountPaid === 0) return 'Unpaid'
  if (shipment.amountPaid >= shipment.totalAmount) return 'Paid'
  return 'Partially Paid'
}

export const STATUS_ORDER: ShipmentStatus[] = [
  'Received', 'Processing', 'Packed', 'Dispatched',
  'In Transit', 'Arrived', 'Ready for Collection', 'Delivered',
]

export const SHIPPING_RATES: Record<Currency, { id: string; label: string; rate: number }[]> = {
  TZS: [
    { id: 'air-express-tzs', label: 'Air Cargo Express', rate: 3_800_000 },
    { id: 'air-standard-tzs', label: 'Air Cargo Standard', rate: 2_420_000 },
    { id: 'sea-lcl-tzs', label: 'Sea Cargo LCL', rate: 1_980_000 },
    { id: 'sea-fcl20-tzs', label: 'Sea Cargo FCL 20ft', rate: 3_500_000 },
    { id: 'sea-fcl40-tzs', label: 'Sea Cargo FCL 40ft', rate: 5_800_000 },
    { id: 'dtd-tzs', label: 'Door-to-Door Delivery', rate: 2_200_000 },
    { id: 'parcel-tzs', label: 'Parcel Delivery', rate: 850_000 },
  ],
  USD: [
    { id: 'air-express-usd', label: 'Air Cargo Express', rate: 1_400 },
    { id: 'air-standard-usd', label: 'Air Cargo Standard', rate: 900 },
    { id: 'sea-lcl-usd', label: 'Sea Cargo LCL', rate: 730 },
    { id: 'sea-fcl20-usd', label: 'Sea Cargo FCL 20ft', rate: 1_300 },
    { id: 'sea-fcl40-usd', label: 'Sea Cargo FCL 40ft', rate: 2_150 },
    { id: 'dtd-usd', label: 'Door-to-Door Delivery', rate: 820 },
    { id: 'parcel-usd', label: 'Parcel Delivery', rate: 315 },
  ],
  AED: [
    { id: 'air-express-aed', label: 'Air Cargo Express', rate: 5_150 },
    { id: 'air-standard-aed', label: 'Air Cargo Standard', rate: 3_300 },
    { id: 'sea-lcl-aed', label: 'Sea Cargo LCL', rate: 2_690 },
    { id: 'sea-fcl20-aed', label: 'Sea Cargo FCL 20ft', rate: 4_770 },
    { id: 'sea-fcl40-aed', label: 'Sea Cargo FCL 40ft', rate: 7_900 },
    { id: 'dtd-aed', label: 'Door-to-Door Delivery', rate: 3_000 },
    { id: 'parcel-aed', label: 'Parcel Delivery', rate: 1_160 },
  ],
}

export const DEFAULT_CURRENCY: Currency = 'TZS'
export const COMPANY_NAME = 'HOPEX CARGO'
export const DEFAULT_ORIGIN = 'Dubai, UAE'
export const DEFAULT_DESTINATION_COUNTRY = 'Tanzania'
