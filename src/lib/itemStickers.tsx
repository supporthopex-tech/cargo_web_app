import { renderToStaticMarkup } from 'react-dom/server'
import { QRCodeSVG } from 'qrcode.react'
import hopexLogo from '../imports/hopex-logo.png'
import type { CompanySettings, Customer, ItemStickerSize, Shipment, ShipmentItem } from '../types'
import { barcodePngDataUrl } from './barcode.ts'

export interface StickerEntry {
  item: ShipmentItem
  shipment: Shipment
  customer?: Customer
  copies?: number
}

const SIZE_MM: Record<ItemStickerSize, { width: number; height: number; qr: number; barcode: number }> = {
  '50x30': { width: 50, height: 30, qr: 76, barcode: 4.5 },
  '60x40': { width: 60, height: 40, qr: 104, barcode: 5.5 },
  '100x50': { width: 100, height: 50, qr: 132, barcode: 8 },
}

export function itemQrUrl(itemCode: string, origin = window.location.origin): string {
  const url = new URL(origin)
  url.searchParams.set('item', itemCode)
  return url.toString()
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] || character)
}

function stickerMarkup(entry: StickerEntry, size: ItemStickerSize, origin: string, logoUrl: string): string {
  const dimensions = SIZE_MM[size]
  const itemCode = entry.item.itemCode || `${entry.shipment.trackingNumber}-${String(entry.item.itemNumber).padStart(2, '0')}`
  const qr = renderToStaticMarkup(<QRCodeSVG value={itemQrUrl(itemCode, origin)} size={dimensions.qr} level="H" marginSize={1} />)
  const customerName = entry.customer?.company || entry.customer?.name || entry.shipment.customerNameSnapshot || 'Customer'
  // Code 128 barcode, no baked-in text (the item code is already printed
  // above it as `.item-code`) — coexists with the QR rather than
  // replacing it, same as every other generated document.
  const barcode = barcodePngDataUrl(itemCode, { displayValue: false, heightPx: 60 })
  return `<section class="sticker">
    <div class="brand"><img src="${escapeHtml(logoUrl)}" alt="Hopex Express Cargo" /></div>
    <div class="qr">${qr}</div>
    <div class="details">
      <div class="item-code">${escapeHtml(itemCode)}</div>
      <div class="label">CUSTOMER</div><div class="primary">${escapeHtml(customerName.toUpperCase())}</div>
      <div class="label">ITEM</div><div class="primary">${escapeHtml(entry.item.description.toUpperCase())}</div>
      <div class="qty"><span>QTY</span> ${escapeHtml(String(entry.item.quantity))} ${escapeHtml(entry.item.unit)}</div>
      <div class="footer"><span>${escapeHtml(entry.shipment.trackingNumber)}</span><strong>${escapeHtml(entry.shipment.shipmentType.toUpperCase())}</strong></div>
    </div>
    ${barcode ? `<div class="barcode"><img src="${escapeHtml(barcode)}" alt="" /></div>` : ''}
  </section>`
}

export function buildItemStickerHtml(
  entries: StickerEntry[],
  size: ItemStickerSize,
  origin = window.location.origin,
  logoUrl = new URL(hopexLogo, window.location.href).href,
  autoPrint = true,
): string {
  const printable = entries.flatMap(entry => Array.from(
    { length: Math.max(1, Math.min(100, Math.floor(entry.copies || 1))) },
    () => stickerMarkup(entry, size, origin, logoUrl),
  ))
  const dimensions = SIZE_MM[size]
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hopex Item Stickers</title>
    <style>
      @page { size: ${dimensions.width}mm ${dimensions.height}mm; margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; color: #000; font-family: Arial, Helvetica, sans-serif; }
      .sticker { width: ${dimensions.width}mm; height: ${dimensions.height}mm; padding: 1.5mm; display: grid; grid-template-columns: ${Math.round(dimensions.width * 0.36)}mm 1fr; grid-template-rows: 6mm 1fr ${dimensions.barcode}mm; gap: 0.8mm 1.5mm; overflow: hidden; page-break-after: always; break-after: page; border: 0.25mm solid #000; }
      .sticker:last-child { page-break-after: auto; break-after: auto; }
      .brand { grid-column: 1 / -1; height: 6mm; display: flex; align-items: center; border-bottom: 0.25mm solid #000; padding-bottom: 0.5mm; }
      .brand img { max-height: 5mm; max-width: 34mm; object-fit: contain; object-position: left center; filter: grayscale(1) contrast(1.4); }
      .qr { display: flex; align-items: center; justify-content: center; overflow: hidden; }
      .qr svg { width: 100%; height: auto; max-height: 100%; }
      .details { min-width: 0; display: flex; flex-direction: column; justify-content: center; line-height: 1.05; }
      .barcode { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; overflow: hidden; border-top: 0.2mm solid #000; }
      .barcode img { height: 100%; width: auto; max-width: 100%; object-fit: contain; }
      .item-code { font: 700 ${size === '50x30' ? '7.5' : '9'}pt ui-monospace, monospace; margin-bottom: 0.7mm; white-space: nowrap; }
      .label { font-size: ${size === '50x30' ? '4.5' : '5.5'}pt; font-weight: 700; margin-top: 0.35mm; }
      .primary { font-size: ${size === '50x30' ? '6.3' : '8'}pt; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .qty { font-size: ${size === '50x30' ? '7' : '9'}pt; font-weight: 900; margin-top: 0.7mm; }
      .qty span { font-size: 5pt; }
      .footer { display: flex; justify-content: space-between; gap: 1mm; margin-top: 0.8mm; padding-top: 0.5mm; border-top: 0.2mm solid #000; font-size: ${size === '50x30' ? '4.5' : '5.5'}pt; white-space: nowrap; }
      @media screen { body { background: #e5e7eb; padding: 10mm; } .sticker { margin: 0 auto 6mm; background: white; box-shadow: 0 2px 10px #999; } }
      @media print { .sticker { border-color: transparent; } }
    </style></head><body>${printable.join('')}${autoPrint ? '<script>window.addEventListener(\'load\',()=>setTimeout(()=>window.print(),250));<\/script>' : ''}</body></html>`
}

export function printItemStickers(
  entries: StickerEntry[],
  settings: CompanySettings,
  size: ItemStickerSize = settings.defaultItemStickerSize,
): boolean {
  if (!entries.length) return false
  const popup = window.open('', '_blank', 'width=900,height=700')
  if (!popup) return false
  popup.document.open()
  popup.document.write(buildItemStickerHtml(entries, size))
  popup.document.close()
  return true
}
