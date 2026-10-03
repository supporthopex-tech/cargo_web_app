import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QRCodeSVG } from 'qrcode.react'
import type { Shipment, PaymentRecord, PackingList, PackingBox, PackingAllocation, CompanySettings, Customer, CargoExtraCharge } from '../types'
import { formatAmount, getPaymentStatus, CARGO_EXTRA_CHARGE_LABELS } from '../types'
import hopexLogoUrl from '../imports/hopex-logo.png'
import { allocationContexts, formatPackingQuantity } from './packing'
import { companyLogoUrl } from './companyBranding'
import { shipmentFinancialSummary } from './accounting'

// ─── helpers ──────────────────────────────────────────────────────────────────

async function loadLogoBase64(logoUrl = hopexLogoUrl): Promise<string | null> {
  try {
    const res = await fetch(logoUrl)
    const blob = await res.blob()
    return await new Promise<string>(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

// Small non-sensitive verification QR: links to the same public tracking page as the
// existing "QR Code — Tracking" share modal on ShipmentDetail (window.location.origin +
// ?tracking=<trackingNumber>) — no customer/financial data is encoded, only the tracking
// number that is already printed as plain text on every one of these documents. Takes an
// explicit `origin` (mirrors itemStickers.tsx's itemQrUrl) so it's usable outside a browser.
// `extraParams` lets a specific document (a receipt, an invoice) identify itself in the
// URL too — PublicTracking.tsx reads these to show e.g. "Verifying Receipt #RCT-..." —
// without needing a dedicated per-document-type verification backend/route.
export function trackingVerifyUrl(
  trackingNumber: string,
  origin: string = window.location.origin,
  extraParams?: Record<string, string | undefined>
): string {
  const params = new URLSearchParams({ tracking: trackingNumber })
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value) params.set(key, value)
    }
  }
  return `${origin}?${params.toString()}`
}

// Renders a QRCodeSVG to a PNG data URL so it can be embedded via jsPDF's addImage
// (jsPDF has no native SVG support). Mirrors loadLogoBase64's async-fetch-then-embed
// pattern already used for the company logo. Returns null on any failure (headless/
// test environments, canvas unavailable, etc.) so callers can fall back gracefully.
export async function qrPngDataUrl(value: string, pixelSize = 200): Promise<string | null> {
  try {
    const rawSvgMarkup = renderToStaticMarkup(createElement(QRCodeSVG, { value, size: pixelSize, level: 'M', marginSize: 1 }))
    // renderToStaticMarkup omits the xmlns attribute (fine for inline JSX in an HTML
    // document, but required for a standalone <img src="data:image/svg+xml...">
    // resource — without it Chromium/Firefox silently fail to decode the image).
    const svgMarkup = rawSvgMarkup.includes('xmlns=')
      ? rawSvgMarkup
      : rawSvgMarkup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
    const svgDataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgMarkup)))}`
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('QR image failed to load'))
      img.src = svgDataUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = pixelSize
    canvas.height = pixelSize
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(image, 0, 0, pixelSize, pixelSize)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

// Draws the ONE scannable code on a document: a QR, bottom-center, with a
// "Scan to Verify Document" / "Document No: ..." caption beneath it — per
// the requirement that every document carry exactly one clean verification
// code, never a barcode alongside it. Call this LAST, after all other
// content (including any doc.addPage() calls), so it lands on whichever
// page is actually the final one. `value` is either a resolvable URL (the
// public tracking page, via trackingVerifyUrl — scanning it opens that
// page) or, for documents with no resolvable backend record of their own
// (e.g. a Packing List), a plain identifying string a generic QR scanner
// will simply display as text.
async function drawBottomCenterVerificationQr(
  doc: jsPDF,
  value: string,
  documentNo: string,
  options?: { sizeMm?: number; bottomMarginMm?: number; withCaption?: boolean }
): Promise<void> {
  const dataUrl = await qrPngDataUrl(value, 220)
  if (!dataUrl) return
  const sizeMm = options?.sizeMm ?? 18
  const bottomMarginMm = options?.bottomMarginMm ?? 10
  const withCaption = options?.withCaption ?? true
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const x = (pageW - sizeMm) / 2
  const y = pageH - bottomMarginMm - sizeMm
  doc.addImage(dataUrl, 'PNG', x, y, sizeMm, sizeMm)
  if (withCaption) {
    doc.setFontSize(6)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(120, 120, 120)
    doc.text('Scan to Verify Document', pageW / 2, y + sizeMm + 3.5, { align: 'center' })
    doc.setFontSize(6.5)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(90, 90, 90)
    doc.text(`Document No: ${documentNo}`, pageW / 2, y + sizeMm + 7.5, { align: 'center' })
    doc.setTextColor(0, 0, 0)
  }
}

function formatLongDate(iso: string): string {
  const d = new Date(iso.replace(/\s/, 'T'))
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

// `logo` is pre-loaded once (async) by each caller via loadLogoBase64 and
// passed in here, rather than fetched inside this function — buildPackingListPDF
// calls this synchronously from inside forEach loops (once per page break),
// and threading async/await through those loops isn't worth the risk on a
// document this central. Pass null to fall back to text-only, as before.
function navyHeader(doc: jsPDF, settings: CompanySettings, logo: string | null) {
  const pageWidth = doc.internal.pageSize.width
  doc.setFillColor(12, 28, 53)
  doc.rect(0, 0, pageWidth, 22, 'F')
  const textX = logo ? 40 : 14
  if (logo) {
    // Logo is rendered on the dark navy band, so keep it compact and
    // vertically centered rather than matching the invoice's larger
    // top-left placement (which sits on a white background).
    doc.addImage(logo, 'PNG', 14, 3, 22, 16)
  }
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  doc.text(settings.companyName, textX, 10)
  doc.setFontSize(7)
  doc.setFont('helvetica', 'normal')
  doc.text(settings.businessType, textX, 15)
  const contactLine = [settings.address, settings.phone, settings.email].filter(Boolean).join(' | ')
  if (contactLine) doc.text(contactLine, textX, 19)
  doc.setTextColor(0, 0, 0)
}

function blobUrl(doc: jsPDF): string {
  return doc.output('bloburl') as unknown as string
}

// ─── Invoice (matches BESTCOM format) ─────────────────────────────────────────

export async function generateInvoicePDF(
  shipment: Shipment,
  customer: Customer | undefined,
  payments: PaymentRecord[],
  settings: CompanySettings,
  extraCharges: CargoExtraCharge[] = [],
  mode: 'download' | 'view' = 'view'
): Promise<string> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.width
  const invoiceCurrency = shipment.invoiceCurrency ?? shipment.currency
  const baseInvoiceTotal = shipment.invoiceAmount ?? shipment.totalAmount
  const financial = shipmentFinancialSummary(baseInvoiceTotal, shipment.amountPaid, extraCharges)
  const payStatus = financial.paymentStatus

  // ── Logo (top-left) ──
  const logo = await loadLogoBase64(companyLogoUrl(settings.logoPath))
  if (logo) {
    doc.addImage(logo, 'PNG', 14, 8, 50, 22)
  } else {
    doc.setFontSize(18)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(12, 28, 53)
    doc.text(settings.companyName, 14, 22)
  }

  // ── Company info (top-right) ──
  const rx = pageW - 14
  doc.setTextColor(12, 28, 53)
  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.text(settings.companyName, rx, 12, { align: 'right' })
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(60, 60, 60)
  if (settings.bankName) doc.text(`Bank: ${settings.bankName}`, rx, 18, { align: 'right' })
  if (settings.bankAccount) doc.text(`Account: ${settings.bankAccount}`, rx, 23, { align: 'right' })
  if (settings.bankAccountName) doc.text(`Account Name: ${settings.bankAccountName}`, rx, 28, { align: 'right' })

  // ── UNPAID / PAID stamp ──
  const isPaid = payStatus === 'Paid'
  const isPartial = payStatus === 'Partially Paid'
  const stampText = isPaid ? 'PAID' : isPartial ? 'PARTIAL' : 'UNPAID'
  const stampR = isPaid ? 22 : isPartial ? 180 : 220
  const stampG = isPaid ? 163 : isPartial ? 120 : 38
  const stampB = isPaid ? 74 : isPartial ? 11 : 38

  doc.setFontSize(24)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(stampR, stampG, stampB)
  doc.text(stampText, pageW - 10, 22, { align: 'right', angle: 20 })
  doc.setTextColor(0, 0, 0)

  // ── Horizontal divider ──
  doc.setDrawColor(200, 200, 200)
  doc.setLineWidth(0.4)
  doc.line(14, 36, pageW - 14, 36)

  // ── Invoice header band ──
  doc.setFillColor(245, 246, 248)
  doc.rect(14, 38, pageW - 28, 24, 'F')
  doc.setDrawColor(210, 210, 215)
  doc.setLineWidth(0.3)
  doc.rect(14, 38, pageW - 28, 24)

  doc.setTextColor(0, 0, 0)
  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.text(`Invoice #${shipment.invoiceNumber || shipment.trackingNumber}`, 18, 47)
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(60, 60, 60)
  doc.text(`Invoice Date: ${formatLongDate(shipment.createdAt)}`, 18, 54)
  doc.text(`Due Date: ${formatLongDate(shipment.createdAt)}`, 18, 59)

  // ── Invoiced To ──
  let y = 72
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(0, 0, 0)
  doc.text('Invoiced To', 14, y); y += 6
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(40, 40, 40)
  const lines = [
    shipment.customerNameSnapshot || customer?.company,
    shipment.customerPhoneSnapshot ? `Phone: ${shipment.customerPhoneSnapshot}` : customer?.phone ? `Phone: ${customer.phone}` : null,
    shipment.customerEmailSnapshot ? `Email: ${shipment.customerEmailSnapshot}` : customer?.email ? `Email: ${customer.email}` : null,
    customer?.address || null,
    customer?.city ? `${customer.city}, Tanzania` : 'Tanzania',
    'Tanzania',
  ].filter(Boolean) as string[]
  lines.forEach(line => { doc.text(line, 14, y); y += 5 })

  y += 6

  // ── Cargo items ──
  const cargoRows = shipment.items.length > 0
    ? shipment.items.map(item => [String(item.itemNumber), item.description, String(item.quantity), item.unit])
    : [['1', shipment.description, String(shipment.pcs), 'PCS']]

  autoTable(doc, {
    startY: y,
    head: [['No.', 'Cargo Item', 'Quantity', 'Unit']],
    body: cargoRows,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [12, 28, 53] },
    margin: { left: 14, right: 14 },
  })

  y = (doc as any).lastAutoTable.finalY + 5

  const measurement = shipment.pricingUnit === 'CBM'
    ? `${shipment.volumeCbm} CBM`
    : `${shipment.weightKg} KG`
  const appliedRate = shipment.appliedRateUsd ?? shipment.baseRate
  const freightDescription = `${shipment.shipmentType} — ${measurement} × USD ${appliedRate}/${shipment.pricingUnit || 'unit'}`
  const billableChargeRows = extraCharges
    .filter(charge => charge.status === 'ACTIVE' && charge.direction === 'billable_to_customer')
    .map(charge => [
      charge.chargeType === 'other' ? charge.customLabel || 'Other' : CARGO_EXTRA_CHARGE_LABELS[charge.chargeType],
      formatAmount(charge.amount, charge.currency),
    ])
  const financialRows = [
    ['Shipping Method', shipment.shipmentType],
    ['Shipping Calculation', freightDescription],
    ['Base Amount USD', formatAmount(shipment.baseAmountUsd ?? shipment.baseRate, 'USD')],
    ['Selected Invoice Currency', invoiceCurrency],
    ['Exchange Rate Used', shipment.selectedExchangeRate ? `1 USD = ${shipment.selectedExchangeRate} ${invoiceCurrency}` : 'Not applicable'],
    ['Exchange Rate Date', shipment.exchangeRateDate || 'Not applicable'],
    ['Base Invoice', formatAmount(financial.baseShipmentCharges, invoiceCurrency)],
    ...billableChargeRows,
  ]

  autoTable(doc, {
    startY: y,
    head: [['Financial Summary', 'Value']],
    body: financialRows,
    foot: [
      [{ content: 'TOTAL DUE', styles: { halign: 'right', fontStyle: 'bold', fillColor: [240, 242, 245] } }, { content: formatAmount(financial.totalDue, invoiceCurrency), styles: { halign: 'right', fontStyle: 'bold', fillColor: [240, 242, 245] } }],
    ],
    styles: { fontSize: 9, cellPadding: 4, lineColor: [200, 200, 200], lineWidth: 0.3 },
    headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', lineColor: [200, 200, 200], lineWidth: 0.3 },
    footStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], lineColor: [200, 200, 200], lineWidth: 0.3 },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 48, halign: 'right' },
    },
    tableLineColor: [200, 200, 200],
    tableLineWidth: 0.3,
    margin: { left: 14, right: 14 },
  })

  y = (doc as any).lastAutoTable.finalY + 12

  // ── Transactions heading ──
  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(0, 0, 0)
  doc.text('Transactions', 14, y); y += 5

  const postedPayments = payments.filter(payment => payment.status === 'POSTED' || payment.status === undefined)
  const txRows = postedPayments.length > 0
    ? postedPayments.map(p => [p.date, p.method, p.receiptNumber, formatAmount(p.amount, p.currency)])
    : [['', '', 'No Related Transactions Found', '']]

  autoTable(doc, {
    startY: y,
    head: [['Transaction Date', 'Gateway', 'Transaction ID', 'Amount']],
    body: txRows,
    foot: [
      [
        { content: '', colSpan: 2 },
        { content: 'Balance', styles: { halign: 'right', fontStyle: 'bold', fillColor: [240, 242, 245] } },
        { content: formatAmount(Math.max(0, financial.balance), invoiceCurrency), styles: { halign: 'right', fontStyle: 'bold', fillColor: [240, 242, 245] } },
      ],
    ],
    styles: { fontSize: 8, cellPadding: 3, lineColor: [200, 200, 200], lineWidth: 0.3 },
    headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', lineColor: [200, 200, 200], lineWidth: 0.3 },
    footStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], lineColor: [200, 200, 200], lineWidth: 0.3 },
    tableLineColor: [200, 200, 200],
    tableLineWidth: 0.3,
    margin: { left: 14, right: 14 },
  })

  y = (doc as any).lastAutoTable.finalY + 10

  // ── Footer ──
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(120, 120, 120)
  doc.text(`PDF Generated on ${formatLongDate(new Date().toISOString())}`, pageW / 2, y, { align: 'center' })
  doc.setFontSize(7)
  doc.text(`${settings.companyName} Management System`, pageW / 2, y + 5, { align: 'center' })

  // ── Verification QR (the ONE scannable code on this document — no
  //    barcode; bottom-center, encodes the invoice's tracking-verify URL) ──
  await drawBottomCenterVerificationQr(
    doc,
    trackingVerifyUrl(shipment.trackingNumber, undefined, { invoice: shipment.invoiceNumber || undefined }),
    shipment.invoiceNumber || shipment.trackingNumber
  )

  if (mode === 'download') {
    doc.save(`invoice-${shipment.trackingNumber}.pdf`)
    return ''
  }
  return blobUrl(doc)
}

// ─── Shipping Label ────────────────────────────────────────────────────────────

export async function printShippingLabel(
  shipment: Shipment,
  customer: Customer | undefined,
  settings: CompanySettings,
  mode: 'download' | 'view' = 'download'
): Promise<string> {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [152, 101] })
  const logo = await loadLogoBase64(companyLogoUrl(settings.logoPath))
  doc.setFillColor(248, 249, 250)
  doc.rect(0, 0, 152, 101, 'F')
  doc.setFillColor(12, 28, 53)
  doc.rect(0, 0, 152, 18, 'F')
  if (logo) doc.addImage(logo, 'PNG', 122, 2, 22, 14)
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.text(settings.companyName, 8, 8)
  doc.setFontSize(7)
  doc.setFont('helvetica', 'normal')
  doc.text('SHIPPING LABEL', 8, 13)
  doc.setTextColor(0, 0, 0)
  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.text(shipment.trackingNumber, 8, 24)
  // This physical 152x101mm sticker is already packed edge-to-edge (FROM/TO,
  // weight/volume/pieces, consignee) with no room left for a second,
  // bottom-center QR band without cramping content that's genuinely needed
  // on a warehouse box label. It keeps its single QR here, top-right, as
  // its one scannable code — the barcode below (the actual duplicate) is
  // what's removed.
  const labelQr = await qrPngDataUrl(trackingVerifyUrl(shipment.trackingNumber), 160)
  if (labelQr) {
    doc.addImage(labelQr, 'PNG', 120, 20, 24, 24)
  } else {
    doc.setDrawColor(180, 180, 180)
    doc.rect(120, 20, 24, 24)
    doc.setFontSize(5)
    doc.setFont('helvetica', 'normal')
    doc.text('QR CODE', 126, 33)
  }
  doc.setFillColor(249, 115, 22)
  doc.roundedRect(8, 26, 30, 7, 2, 2, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(7)
  doc.setFont('helvetica', 'bold')
  doc.text(shipment.shipmentType.toUpperCase(), 10, 31)
  doc.setTextColor(0, 0, 0)
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.text('FROM:', 8, 39)
  doc.setFont('helvetica', 'normal')
  doc.text(shipment.origin, 8, 44)
  doc.setFont('helvetica', 'bold')
  doc.text('TO:', 8, 52)
  doc.setFont('helvetica', 'normal')
  doc.text(`${shipment.destinationCity}, Tanzania`, 8, 57)
  doc.setDrawColor(200, 200, 200)
  doc.line(8, 61, 144, 61)
  const cols = [
    { label: 'WEIGHT', value: `${shipment.weightKg} kg` },
    { label: 'VOLUME', value: `${shipment.volumeCbm} cbm` },
    { label: 'PIECES', value: `${shipment.pcs} pcs` },
    { label: 'TYPE', value: shipment.cargoCategory },
  ]
  cols.forEach((col, i) => {
    const x = 8 + i * 35
    doc.setFontSize(7)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(100, 100, 100)
    doc.text(col.label, x, 66)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(0, 0, 0)
    doc.text(col.value, x, 72)
  })
  doc.line(8, 75, 144, 75)
  doc.setFontSize(7)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(100, 100, 100)
  doc.text('CONSIGNEE', 8, 80)
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(0, 0, 0)
  doc.text(customer?.company || 'N/A', 8, 85)
  doc.setFontSize(7)
  doc.text(customer ? `${customer.name} | ${customer.phone}` : '', 8, 90)
  doc.setFontSize(6)
  doc.setTextColor(140, 140, 140)
  doc.text(`Printed: ${new Date().toLocaleDateString()}`, 144, 96, { align: 'right' })
  doc.setTextColor(0, 0, 0)

  if (mode === 'view') return blobUrl(doc)
  doc.save(`label-${shipment.trackingNumber}.pdf`)
  return ''
}

// ─── Payment Receipt ───────────────────────────────────────────────────────────

export async function printPaymentReceipt(
  payment: PaymentRecord,
  shipment: Shipment,
  customer: Customer | undefined,
  settings: CompanySettings,
  allPayments: PaymentRecord[],
  extraCharges: CargoExtraCharge[] = [],
  mode: 'download' | 'view' = 'download'
): Promise<string> {
  const doc = new jsPDF({ unit: 'mm', format: 'a5' })
  const invoiceCurrency = shipment.invoiceCurrency ?? shipment.currency
  const invoiceTotal = shipment.invoiceAmount ?? shipment.totalAmount
  const logo = await loadLogoBase64(companyLogoUrl(settings.logoPath))
  navyHeader(doc, settings, logo)
  let y = 30
  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.text('PAYMENT RECEIPT', 14, y); y += 8
  const details = [
    ['Receipt Number:', payment.receiptNumber],
    ['Date:', payment.date],
    ['Tracking #:', shipment.trackingNumber],
    ['Customer:', customer?.company || 'N/A'],
    ['Contact:', customer?.name || 'N/A'],
  ]
  details.forEach(([label, val]) => {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.text(label, 14, y)
    doc.setFont('helvetica', 'normal')
    doc.text(val, 65, y)
    y += 6
  })
  y += 4
  doc.setDrawColor(200, 200, 200)
  doc.line(14, y, 134, y); y += 6
  autoTable(doc, {
    startY: y,
    head: [['Description', 'Amount']],
    body: [[`Payment — ${shipment.trackingNumber}`, formatAmount(payment.amount, payment.currency)]],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [12, 28, 53] },
    margin: { left: 14, right: 14 },
  })
  y = (doc as any).lastAutoTable.finalY + 8
  const totalPaid = allPayments
    .filter(p => p.shipmentId === shipment.id && (p.status === 'POSTED' || p.status === undefined))
    .reduce((sum, candidate) => sum + candidate.amount, 0)
  const financial = shipmentFinancialSummary(invoiceTotal, totalPaid, extraCharges)
  const balance = financial.balance
  const summary = [
    ['Invoice Number:', shipment.invoiceNumber || shipment.trackingNumber],
    ['Base Invoice:', formatAmount(invoiceTotal, invoiceCurrency)],
    ['Billable Extra Charges:', formatAmount(financial.billableExtraCharges, invoiceCurrency)],
    ['Total Due:', formatAmount(financial.totalDue, invoiceCurrency)],
    ['Total Paid:', formatAmount(totalPaid, invoiceCurrency)],
    ['Remaining Balance:', formatAmount(Math.max(0, balance), invoiceCurrency)],
    ['Payment Method:', payment.method],
    ['Processed By:', payment.createdBy],
    ['Status:', financial.paymentStatus],
  ]
  summary.forEach(([label, val]) => {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.text(label, 14, y)
    doc.setFont('helvetica', 'normal')
    if (label === 'Remaining Balance:' && balance > 0) doc.setTextColor(220, 38, 38)
    doc.text(val, 90, y)
    doc.setTextColor(0, 0, 0)
    y += 6
  })
  y += 6
  doc.setFontSize(7)
  doc.setTextColor(120, 120, 120)
  doc.text(settings.termsAndConditions, 14, y, { maxWidth: 120 })

  // ── Verification QR (the ONE scannable code on this document — no
  //    barcode; bottom-center, encodes this receipt's tracking-verify URL) ──
  await drawBottomCenterVerificationQr(
    doc,
    trackingVerifyUrl(shipment.trackingNumber, undefined, { receipt: payment.receiptNumber }),
    payment.receiptNumber,
    { sizeMm: 16, bottomMarginMm: 6 }
  )

  if (mode === 'view') return blobUrl(doc)
  doc.save(`receipt-${payment.receiptNumber}.pdf`)
  return ''
}

// ─── Packing List ──────────────────────────────────────────────────────────────

export async function buildPackingListPDF(
  pl: PackingList,
  shipments: Shipment[],
  boxes: PackingBox[],
  allocations: PackingAllocation[],
  customers: Customer[],
  settings: CompanySettings,
): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const logo = await loadLogoBase64(companyLogoUrl(settings.logoPath))
  navyHeader(doc, settings, logo)
  let y = 28
  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.text('PACKING LIST', 14, y); y += 7
  const meta = [
    ['Packing List #:', pl.listId],
    ['Status:', pl.status],
    ['Origin:', pl.origin],
    ['Destination:', pl.destination],
    ['Type:', pl.shipmentType],
    ['Created:', pl.createdAt],
    ...(pl.closedAt ? [['Closed:', pl.closedAt]] : []),
    ...(pl.closedBy ? [['Closed By:', pl.closedBy]] : []),
    ...(pl.dispatchedAt ? [['Dispatched:', pl.dispatchedAt]] : []),
  ]
  meta.forEach(([label, val]) => {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.text(label, 14, y)
    doc.setFont('helvetica', 'normal')
    doc.text(val, 60, y)
    y += 6
  })
  y += 4
  const contexts = allocationContexts(pl.id, boxes, allocations, shipments, customers)
  const listBoxes = boxes.filter(box => box.packingListId === pl.id).sort((a, b) => a.boxNumber - b.boxNumber)
  const pageHeight = doc.internal.pageSize.getHeight()
  const addPageIfNeeded = (needed: number) => {
    if (y + needed <= pageHeight - 18) return
    doc.addPage(); navyHeader(doc, settings, logo); y = 28
  }
  const totalsByUnit = new Map<string, number>()

  if (contexts.length > 0) {
    listBoxes.forEach(box => {
      const boxContexts = contexts.filter(context => context.box.id === box.id)
      if (!boxContexts.length) return
      addPageIfNeeded(24)
      doc.setFillColor(12, 28, 53)
      doc.rect(14, y - 4, 182, 8, 'F')
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(10)
      doc.text(`BOX ${String(box.boxNumber).padStart(3, '0')}`, 17, y + 1)
      doc.setTextColor(0, 0, 0); y += 8

      const customerGroups = new Map<string, typeof boxContexts>()
      boxContexts.forEach(context => {
        const key = context.customer?.id || context.shipment.customerId
        customerGroups.set(key, [...(customerGroups.get(key) || []), context])
      })
      customerGroups.forEach(group => {
        addPageIfNeeded(22)
        const customerName = group[0].customer?.company || group[0].customer?.name || group[0].shipment.customerNameSnapshot || 'Customer'
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text(customerName.toUpperCase(), 16, y); y += 3
        const rows = group.map(context => {
          totalsByUnit.set(context.item.unit, (totalsByUnit.get(context.item.unit) || 0) + context.allocation.quantity)
          return [context.item.itemCode || '', context.item.description, context.shipment.trackingNumber, `${formatPackingQuantity(context.allocation.quantity)} ${context.item.unit}`]
        })
        autoTable(doc, {
          startY: y,
          head: [['Item Code', 'Item', 'Tracking', 'Quantity']],
          body: rows,
          styles: { fontSize: 8, cellPadding: 1.8 },
          headStyles: { fillColor: [235, 238, 242], textColor: [35, 45, 58], fontStyle: 'bold' },
          columnStyles: { 0: { cellWidth: 35 }, 2: { cellWidth: 42 }, 3: { cellWidth: 30, halign: 'right' } },
          margin: { left: 16, right: 14 },
        })
        y = (doc as any).lastAutoTable.finalY + 2
        const customerTotals = new Map<string, number>()
        group.forEach(context => customerTotals.set(context.item.unit, (customerTotals.get(context.item.unit) || 0) + context.allocation.quantity))
        doc.setFontSize(8); doc.setFont('helvetica', 'bold')
        doc.text(`Customer Total: ${[...customerTotals].map(([unit, quantity]) => `${formatPackingQuantity(quantity)} ${unit}`).join(' | ')}`, 196, y, { align: 'right' })
        y += 6
      })
      const boxTotals = new Map<string, number>()
      boxContexts.forEach(context => boxTotals.set(context.item.unit, (boxTotals.get(context.item.unit) || 0) + context.allocation.quantity))
      doc.setDrawColor(120, 120, 120); doc.line(120, y - 2, 196, y - 2)
      doc.setFontSize(9); doc.setFont('helvetica', 'bold')
      doc.text(`BOX TOTAL: ${[...boxTotals].map(([unit, quantity]) => `${formatPackingQuantity(quantity)} ${unit}`).join(' | ')}`, 196, y + 2, { align: 'right' })
      y += 9
    })

    addPageIfNeeded(28)
    const totalCustomers = new Set(contexts.map(context => context.customer?.id || context.shipment.customerId)).size
    const totalItemTypes = new Set(contexts.map(context => context.item.id)).size
    autoTable(doc, {
      startY: y,
      head: [['PACKING LIST SUMMARY', 'TOTAL']],
      body: [
        ['Total Boxes', String(listBoxes.filter(box => contexts.some(context => context.box.id === box.id)).length)],
        ['Total Customers', String(totalCustomers)],
        ['Total Item Types', String(totalItemTypes)],
        ['Total Quantities', [...totalsByUnit].map(([unit, quantity]) => `${formatPackingQuantity(quantity)} ${unit}`).join(' | ')],
      ],
      styles: { fontSize: 9 }, headStyles: { fillColor: [12, 28, 53] },
      columnStyles: { 1: { halign: 'right', fontStyle: 'bold' } }, margin: { left: 14, right: 14 },
    })
    y = (doc as any).lastAutoTable.finalY + 12
  } else {
    const totals = shipments.reduce((acc, shipment) => ({ kg: acc.kg + shipment.weightKg, cbm: acc.cbm + shipment.volumeCbm, pcs: acc.pcs + shipment.pcs }), { kg: 0, cbm: 0, pcs: 0 })
    const rows = shipments.map(shipment => [shipment.trackingNumber, shipment.description.slice(0, 40), shipment.destinationCity, `${shipment.weightKg} kg`, `${shipment.volumeCbm} cbm`, `${shipment.pcs} pcs`, shipment.status])
    rows.push(['', 'TOTALS', '', `${totals.kg} kg`, `${totals.cbm.toFixed(2)} cbm`, `${totals.pcs} pcs`, ''])
    autoTable(doc, { startY: y, head: [['Tracking #', 'Description', 'Destination', 'Weight', 'Volume', 'Pieces', 'Status']], body: rows, styles: { fontSize: 8 }, headStyles: { fillColor: [12, 28, 53] }, margin: { left: 14, right: 14 }, didParseCell: data => { if (data.row.index === rows.length - 1) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [240, 240, 240] } } })
    y = (doc as any).lastAutoTable.finalY + 12
  }

  addPageIfNeeded(15)
  const finalY = y
  doc.setFontSize(9)
  doc.line(14, finalY, 80, finalY)
  doc.text('Prepared By', 14, finalY + 5)
  doc.line(100, finalY, 166, finalY)
  doc.text('Authorized By', 100, finalY + 5)

  // ── Verification QR (the ONE scannable code on this document — no
  //    barcode; bottom-center, drawn last and un-targeted at any specific
  //    page so it lands on whichever page addPageIfNeeded() left active —
  //    i.e. only the FINAL page of a multi-page packing list, never every
  //    page). A Packing List has no single shipment/public tracking page of
  //    its own, so this encodes its own list ID as plain identifying text
  //    rather than a resolvable URL — any QR scanner still displays it. ──
  await drawBottomCenterVerificationQr(doc, `${settings.companyName} PACKING LIST ${pl.listId}`, pl.listId)

  return doc
}

export async function printPackingList(
  pl: PackingList,
  shipments: Shipment[],
  boxes: PackingBox[],
  allocations: PackingAllocation[],
  customers: Customer[],
  settings: CompanySettings,
  mode: 'download' | 'view' = 'download'
): Promise<string> {
  const doc = await buildPackingListPDF(pl, shipments, boxes, allocations, customers, settings)
  if (mode === 'view') return blobUrl(doc)
  doc.save(`packing-list-${pl.listId}.pdf`)
  return ''
}

// ─── Shipment Receipt ──────────────────────────────────────────────────────────

export async function printShipmentReceipt(
  shipment: Shipment,
  customer: Customer | undefined,
  payments: PaymentRecord[],
  settings: CompanySettings,
  extraCharges: CargoExtraCharge[] = [],
  mode: 'download' | 'view' = 'download'
): Promise<string> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const invoiceCurrency = shipment.invoiceCurrency ?? shipment.currency
  const baseInvoiceTotal = shipment.invoiceAmount ?? shipment.totalAmount
  const financial = shipmentFinancialSummary(baseInvoiceTotal, shipment.amountPaid, extraCharges)
  const logo = await loadLogoBase64(companyLogoUrl(settings.logoPath))
  navyHeader(doc, settings, logo)
  let y = 28
  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.text('SHIPMENT RECEIPT', 14, y); y += 8
  const meta: [string, string][] = [
    ['Tracking Number:', shipment.trackingNumber],
    ['Status:', shipment.status],
    ['Date:', shipment.createdAt],
    ['Shipment Type:', shipment.shipmentType],
    ['Service Type:', shipment.serviceType],
    ['Customer:', customer?.company || 'N/A'],
    ['Contact:', customer ? `${customer.name} | ${customer.phone}` : 'N/A'],
    ['Origin:', shipment.origin],
    ['Destination:', `${shipment.destinationCity}, Tanzania`],
    ['Description:', shipment.description],
  ]
  meta.forEach(([label, val]) => {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.text(label, 14, y)
    doc.setFont('helvetica', 'normal')
    doc.text(val, 70, y, { maxWidth: 110 })
    y += 6
  })
  y += 4
  autoTable(doc, {
    startY: y,
    head: [['Weight (KG)', 'Volume (CBM)', 'Pieces', 'Category']],
    body: [[shipment.weightKg, shipment.volumeCbm, shipment.pcs, shipment.cargoCategory]],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [12, 28, 53] },
    margin: { left: 14, right: 14 },
  })
  y = (doc as any).lastAutoTable.finalY + 6
  autoTable(doc, {
    startY: y,
    head: [['Charge', 'Amount']],
    body: [
      ['Base Amount USD', formatAmount(shipment.baseAmountUsd ?? shipment.baseRate, 'USD')],
      ['Invoice Currency', invoiceCurrency],
      ['Base Invoice', formatAmount(financial.baseShipmentCharges, invoiceCurrency)],
      ...extraCharges
        .filter(charge => charge.status === 'ACTIVE' && charge.direction === 'billable_to_customer')
        .map(charge => [charge.chargeType === 'other' ? charge.customLabel || 'Other' : CARGO_EXTRA_CHARGE_LABELS[charge.chargeType], formatAmount(charge.amount, charge.currency)]),
      ['TOTAL AMOUNT', formatAmount(financial.totalDue, invoiceCurrency)],
      ['Amount Paid', formatAmount(shipment.amountPaid, invoiceCurrency)],
      ['Balance Due', formatAmount(Math.max(0, financial.balance), invoiceCurrency)],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [12, 28, 53] },
    margin: { left: 14, right: 14 },
    didParseCell: (data) => { if (data.column.index === 0 && ['TOTAL AMOUNT', 'Balance Due'].includes(String(data.cell.text[0]))) data.cell.styles.fontStyle = 'bold' },
  })
  y = (doc as any).lastAutoTable.finalY + 6
  const postedPayments = payments.filter(payment => payment.status === 'POSTED' || payment.status === undefined)
  if (postedPayments.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['Receipt #', 'Date', 'Method', 'Amount', 'Note']],
      body: postedPayments.map(p => [p.receiptNumber, p.date, p.method, formatAmount(p.amount, p.currency), p.note || '']),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [30, 64, 112] },
      margin: { left: 14, right: 14 },
    })
    y = (doc as any).lastAutoTable.finalY + 8
  }
  doc.setFontSize(7)
  doc.setTextColor(120, 120, 120)
  doc.text(settings.termsAndConditions, 14, y, { maxWidth: 170 })

  // ── Verification QR (the ONE scannable code on this document — no
  //    barcode; bottom-center, encodes this shipment's tracking-verify URL) ──
  await drawBottomCenterVerificationQr(doc, trackingVerifyUrl(shipment.trackingNumber), shipment.trackingNumber)

  if (mode === 'view') return blobUrl(doc)
  doc.save(`shipment-${shipment.trackingNumber}.pdf`)
  return ''
}
