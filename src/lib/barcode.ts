import JsBarcode from 'jsbarcode'

// Renders a Code 128 barcode to a PNG data URL via an off-screen canvas —
// mirrors qrPngDataUrl's canvas-render-then-embed pattern in pdf.ts (jsPDF
// has no native barcode support, same as it has no native SVG support).
// Code 128 handles the full ASCII range these numbers use (letters, digits,
// dashes) without a symbology-specific format check, unlike e.g. EAN/UPC.
export function barcodePngDataUrl(value: string, options?: { heightPx?: number; displayValue?: boolean }): string | null {
  if (!value) return null
  try {
    const canvas = document.createElement('canvas')
    JsBarcode(canvas, value, {
      format: 'CODE128',
      displayValue: options?.displayValue ?? true,
      fontSize: 14,
      height: options?.heightPx ?? 50,
      margin: 6,
      background: '#ffffff',
      lineColor: '#000000',
    })
    return canvas.toDataURL('image/png')
  } catch {
    // Malformed input for the chosen symbology (JsBarcode throws rather than
    // returning an error) — callers render without a barcode rather than
    // let one bad value break the whole document.
    return null
  }
}

// Note: this used to also export drawBottomCenterBarcode() for placing a
// Code 128 barcode bottom-center on generated PDF documents (invoices,
// receipts, packing lists, shipment receipts). That's been removed — those
// documents now carry exactly one scannable code (a QR, via
// drawBottomCenterVerificationQr() in pdf.ts), not a barcode alongside it.
// barcodePngDataUrl() above stays: item stickers (itemStickers.tsx) still
// use it for physical warehouse box/item scanning, a different use case
// from paperwork verification.
